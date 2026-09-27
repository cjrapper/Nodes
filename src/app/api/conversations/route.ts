import { json, readJson, requireWorkspace, serverError } from "@/lib/api/http";
import * as repo from "@/lib/db/repo";

/** 会话列表，附带每条会话的最近一次缓存表现，供侧栏直接展示 */
export async function GET() {
  try {
    const ws = requireWorkspace();
    const conversations = repo.listConversations(ws.id);
    const enriched = conversations.map((c) => {
      const messages = repo.listMessages(c.id);
      const last = repo.getLastInvocation(c.id);
      return {
        ...c,
        messageCount: messages.length,
        refCount: repo.listRefBlockIds(c.id).length,
        lastCache: last
          ? {
              hitRate: last.promptTokens > 0 ? last.cachedTokens / last.promptTokens : 0,
              cachedTokens: last.cachedTokens,
              promptTokens: last.promptTokens,
              savedUsd: last.savedUsd,
            }
          : null,
      };
    });
    return json({ conversations: enriched });
  } catch (err) {
    return serverError(err);
  }
}

interface CreateBody {
  title?: string;
  modelConfigId?: string | null;
  refBlockIds?: string[];
  /** 建会话时就整体挂载的文档/模块 */
  refDocIds?: string[];
}

export async function POST(request: Request) {
  try {
    const ws = requireWorkspace();
    const body = (await readJson<CreateBody>(request)) ?? {};
    const conversation = repo.createConversation({
      workspaceId: ws.id,
      title: body.title ?? "新对话",
      modelConfigId: body.modelConfigId ?? repo.getDefaultModelConfig()?.id ?? null,
      refBlockIds: body.refBlockIds,
    });
    // 模块引用单独写：它和块引用是两张表，createConversation 只管块那部分。
    // 漏掉这一步的症状很难查 —— 建会话时接口返回 201，但挂载的模块其实是空的。
    if (body.refDocIds && body.refDocIds.length > 0) {
      repo.setConversationDocRefs(conversation.id, body.refDocIds);
    }
    return json({ conversation }, 201);
  } catch (err) {
    return serverError(err);
  }
}

interface PatchBody {
  id?: string;
  title?: string;
  modelConfigId?: string | null;
  sourceBudgetTokens?: number;
  /** 整体替换会话挂载的知识块集合 */
  refBlockIds?: string[];
  /** 整体替换会话挂载的文档/模块集合 */
  refDocIds?: string[];
}

export async function PATCH(request: Request) {
  try {
    const body = await readJson<PatchBody>(request);
    if (!body?.id) return json({ error: "缺少 id" }, 400);

    const current = repo.getConversation(body.id);
    if (!current) return json({ error: "会话不存在" }, 404);

    // 改模型是缓存最昂贵的一种操作（服务商缓存不互通），
    // 响应里明确告知，让前端有机会提示用户。
    const modelChanged =
      body.modelConfigId !== undefined && body.modelConfigId !== current.modelConfigId;

    const conversation = repo.updateConversation(body.id, {
      title: body.title,
      modelConfigId: body.modelConfigId,
      sourceBudgetTokens: body.sourceBudgetTokens,
    });

    let refsChanged = false;
    if (body.refBlockIds) {
      const before = repo.listRefBlockIds(body.id).slice().sort();
      repo.setConversationRefs(body.id, body.refBlockIds);
      const after = repo.listRefBlockIds(body.id).slice().sort();
      refsChanged = JSON.stringify(before) !== JSON.stringify(after);
    }

    let docsChanged = false;
    if (body.refDocIds) {
      const before = repo.listRefDocIds(body.id).slice().sort();
      repo.setConversationDocRefs(body.id, body.refDocIds);
      const after = repo.listRefDocIds(body.id).slice().sort();
      docsChanged = JSON.stringify(before) !== JSON.stringify(after);
    }

    return json({
      conversation,
      cacheImpact: {
        modelChanged,
        refsChanged: refsChanged || docsChanged,
        note: modelChanged
          ? "已切换模型：服务商侧缓存不互通，下一次调用需重建全部缓存。"
          : docsChanged
            ? "挂载的模块已变化：L2 模块层缓存会失效，块层与 L0/L1 仍可命中。"
            : refsChanged
              ? "引用集合已变化：L2 层缓存会失效，L0/L1 仍可命中。"
              : "本次修改不影响缓存前缀。",
      },
    });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return json({ error: "缺少 id 参数" }, 400);
    return json({ ok: repo.deleteConversation(id) });
  } catch (err) {
    return serverError(err);
  }
}
