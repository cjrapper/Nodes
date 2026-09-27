import { json, readJson, requireWorkspace, serverError } from "@/lib/api/http";
import {
  buildBlockPaths,
  computeCacheKey,
  contentHash,
  parseMarkdown,
  serializeBlocks,
} from "@/lib/blocks/markdown";
import * as repo from "@/lib/db/repo";

/**
 * 读取文档的 Markdown 与块结构。
 *
 * `blockIds` 与 `blocks` 一一对应，前端编辑后原样回传，
 * 服务端据此判断哪些块是"位置变了"、哪些是"内容变了"。
 */
export async function GET(request: Request) {
  try {
    const docId = new URL(request.url).searchParams.get("docId");
    if (!docId) return json({ error: "缺少 docId 参数" }, 400);

    const doc = repo.getDoc(docId);
    if (!doc) return json({ error: "文档不存在" }, 404);

    const blocks = repo.listBlocks(docId).filter((b) => b.seq >= 0 && b.text.trim());
    const markdown = serializeBlocks(blocks);
    const paths = buildBlockPaths(doc.title, blocks);

    return json({
      doc,
      markdown,
      blockIds: blocks.map((b) => b.id),
      blocks: blocks.map((b, i) => ({
        id: b.id,
        seq: b.seq,
        kind: b.kind,
        // cacheKey 前 8 位即 @ 引用与清单里显示的块标识
        cacheKey: computeCacheKey(b.textHash, b.id),
        path: paths[i] ?? doc.title,
        text: b.text,
        // 这个块被多少个会话引用 —— 编辑它会损失多少缓存，前端据此提示
        refCount: repo.countBlockReferences(b.id),
      })),
    });
  } catch (err) {
    return serverError(err);
  }
}

interface SaveBody {
  docId?: string;
  markdown?: string;
  /** 与本次 markdown 解析出的块一一对应的既有块 id；新块用 null/缺失占位 */
  blockIds?: (string | null)[];
}

/**
 * 保存文档。
 *
 * 响应里带 `cacheImpact`：哪些块的内容真的变了、这些块被多少会话引用。
 * 这是"让缓存成本可见"的关键一环 —— 用户编辑一个被 5 个会话引用的块时，
 * 应当事先知道这一下会让 5 个会话的缓存全部重建。
 */
export async function PUT(request: Request) {
  try {
    requireWorkspace();
    const body = await readJson<SaveBody>(request);
    if (!body?.docId) return json({ error: "缺少 docId" }, 400);
    if (typeof body.markdown !== "string") return json({ error: "缺少 markdown" }, 400);

    const doc = repo.getDoc(body.docId);
    if (!doc) return json({ error: "文档不存在" }, 404);

    const parsed = parseMarkdown(body.markdown);
    const previousIds = body.blockIds ?? [];

    // 保存前后都统计引用数，用于估算缓存影响
    const beforeBlocks = repo.listBlocks(body.docId).filter((b) => b.seq >= 0);
    const beforeIds = beforeBlocks.map((b) => b.id);
    const refCounts = new Map<string, number>();
    for (const id of beforeIds) refCounts.set(id, repo.countBlockReferences(id));

    const inputs = parsed.map((p, index) => ({
      id: previousIds[index] ?? undefined,
      kind: p.kind,
      text: p.text,
    }));

    // 把库里的顺序也传进去作为第二重提示：客户端可能在文档中间插入/删除过，
    // 那样 previousIds 的下标就整体错位了，需要靠内容哈希兜底认领。
    const result = repo.saveDocBlocks(body.docId, inputs, contentHash, beforeIds);

    const changedRefs = [...result.changed, ...result.removed].map((id) => ({
      blockId: id,
      refCount: refCounts.get(id) ?? 0,
    }));
    const affectedConversationCount = changedRefs.filter((c) => c.refCount > 0).length;
    const totalAffectedRefs = changedRefs.reduce((sum, c) => sum + c.refCount, 0);

    // 重新读一遍，把新生成的块 id 返回给前端，供后续保存复用
    const blocks = repo.listBlocks(body.docId).filter((b) => b.seq >= 0 && b.text.trim());
    const paths = buildBlockPaths(doc.title, blocks);

    return json({
      ok: true,
      changed: result.changed,
      created: result.created,
      removed: result.removed,
      blockIds: blocks.map((b) => b.id),
      blocks: blocks.map((b, i) => ({
        id: b.id,
        seq: b.seq,
        kind: b.kind,
        cacheKey: computeCacheKey(b.textHash, b.id),
        path: paths[i] ?? doc.title,
        text: b.text,
        refCount: repo.countBlockReferences(b.id),
      })),
      cacheImpact: {
        changedBlockCount: changedRefs.length,
        affectedBlockCount: affectedConversationCount,
        totalAffectedRefs,
        hasImpact: totalAffectedRefs > 0,
      },
    });
  } catch (err) {
    return serverError(err);
  }
}
