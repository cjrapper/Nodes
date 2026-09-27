import { json, readJson, requireWorkspace, serverError } from "@/lib/api/http";
import * as repo from "@/lib/db/repo";

export async function GET(request: Request) {
  try {
    const ws = requireWorkspace();

    /*
     * `?deleted=1` → 回收站视图。
     *
     * 刻意用同一个接口而不是新开一个 `/api/docs/deleted`：两者返回的都是
     * `docs` 数组，前端只需要换一个数据源就能渲染回收站；分成两个接口之后
     * 迟早会出现"回收站和列表用了两套过滤逻辑"的分叉。
     */
    const deletedOnly = new URL(request.url).searchParams.get("deleted") === "1";
    if (deletedOnly) {
      return json({ docs: repo.listDeletedDocs(ws.id), counts: {}, coverage: {} });
    }

    const docs = repo.listDocs(ws.id);

    /*
     * 块数与"已引用块数"用**一条聚合查询**拿到。
     *
     * 之前是 for 循环里对每篇文档各调一次 listBlocks（N+1）。
     * 现在文档一多就是几百次查询，而这两个数字本来就该一起算 ——
     * 覆盖度需要分母与分子同源。
     */
    const coverage = repo.getDocCoverage(ws.id);
    const counts: Record<string, number> = {};
    for (const doc of docs) {
      counts[doc.id] = coverage[doc.id]?.blockCount ?? 0;
    }

    return json({ docs, counts, coverage });
  } catch (err) {
    return serverError(err);
  }
}

interface CreateBody {
  parentId?: string | null;
  title?: string;
  /** 'doc'（默认）或 'module'（模块容器，不写正文只挂载知识点） */
  kind?: string;
}

export async function POST(request: Request) {
  try {
    const ws = requireWorkspace();
    const body = (await readJson<CreateBody>(request)) ?? {};
    const doc = repo.createDoc({
      workspaceId: ws.id,
      parentId: body.parentId ?? null,
      // 允许空标题：新建时留空比填一个占位名更好认（见 workspace-shell 的注释）
      title: body.title ?? "",
      kind: body.kind === "module" ? "module" : "doc",
    });
    return json({ doc }, 201);
  } catch (err) {
    return serverError(err);
  }
}

interface PatchBody {
  id?: string;
  title?: string;
  icon?: string;
  kind?: string;
  parentId?: string | null;
  sort?: number;
}

export async function PATCH(request: Request) {
  try {
    const body = await readJson<PatchBody>(request);
    if (!body?.id) return json({ error: "缺少 id" }, 400);

    // 防环：不允许把文档挂到自己的子孙下面
    if (body.parentId) {
      let cursor: string | null = body.parentId;
      const guard = new Set<string>();
      while (cursor) {
        if (cursor === body.id) return json({ error: "不能把文档移动到它自己的子文档下" }, 400);
        if (guard.has(cursor)) break;
        guard.add(cursor);
        cursor = repo.getDoc(cursor)?.parentId ?? null;
      }
    }

    const doc = repo.updateDoc(body.id, {
      title: body.title,
      icon: body.icon,
      kind: body.kind === undefined ? undefined : body.kind === "module" ? "module" : "doc",
      parentId: body.parentId,
      sort: body.sort,
    });
    if (!doc) return json({ error: "文档不存在" }, 404);
    return json({ doc });
  } catch (err) {
    return serverError(err);
  }
}

/**
 * 删除 / 恢复 / 彻底清除。
 *
 * `DELETE /api/docs?id=xxx`            → 软删（整棵子树）
 * `DELETE /api/docs?id=xxx&restore=1`  → 撤销上面那次删除
 * `DELETE /api/docs?id=xxx&purge=1`    → **彻底清除**（不可逆，清空回收站）
 *
 * ## 为什么恢复也挂在这个动词上
 *
 * 恢复就是删除的逆操作，而这里已经用 `?id=` 表达"对哪一篇动手"了。
 * 新开一个 `/api/docs/restore` 或复用 `PATCH` 都不如它合适：
 * `PATCH` 走 `updateDoc`，而后者内部的 `getDoc` **会过滤掉已删文档**，
 * 拿它来恢复必然 404（"用只看得见活着文档的通道去复活一篇死文档"）。
 *
 * ## purge 为什么必须存在，以及它的风险
 *
 * 软删之后数据永远留在库里。用户删掉一篇含隐私内容的笔记时，
 * 他要的是"真的没了"而不是"看不见了" —— 没有 purge 的话回收站就是一个
 * 只进不出的黑洞。
 *
 * ⚠️ 这是**唯一的不可逆操作**，所以追加了两道判断：
 *  1. 只清已经软删的（`deleted_at IS NOT NULL`）。传一个活着的 id 会 400，
 *     避免"手滑传错 id 直接永久删除"。
 *  2. 只清一个文档及其子树，没有"清空全部"这种入口 —— 批量永久删除
 *     应该由人一个个确认。
 */
export async function DELETE(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    if (!id) return json({ error: "缺少 id 参数" }, 400);

    if (params.get("purge") === "1") {
      const purged = repo.purgeDoc(id);
      if (!purged) {
        return json(
          {
            error:
              "只能彻底清除已经被删除的文档。请先删除它，确认无误后再清空。",
          },
          400,
        );
      }
      return json({ purged });
    }

    if (params.get("restore") === "1") {
      const blockedBy = repo.findDeletedAncestor(id);
      if (blockedBy) {
        return json(
          {
            error:
              `不能单独恢复：它的上级《${blockedBy.title || "未命名文档"}》也还在回收站里，` +
              `请先恢复那一篇。`,
            blockedBy: { id: blockedBy.id, title: blockedBy.title },
          },
          409,
        );
      }

      const restored = repo.restoreDoc(id);
      if (!restored) {
        return json({ error: "文档不存在，或者它并没有被删除" }, 404);
      }
      return json({ restored });
    }

    const deleted = repo.deleteDoc(id);
    return json({ deleted });
  } catch (err) {
    return serverError(err);
  }
}
