import { json, readJson, serverError } from "@/lib/api/http";
import * as repo from "@/lib/db/repo";
import { undoToolCall } from "@/lib/ai/undo";

/**
 * AI 写入的审计与撤销。
 *
 * `GET  /api/tool-calls?conversationId=xxx` → 列出工具调用（最近的在前面）
 * `GET  /api/tool-calls?id=tc_xxx`          → 单条详情
 * `POST /api/tool-calls`  { id, undo: true } → 撤销那次写入
 *
 * 这是 `docs/agent-write-policy.md` 里"审计要有界面入口"那一条的服务端，
 * 也是"一键撤销"的落点。
 */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    if (id) {
      const record = repo.getToolCall(id);
      if (!record) return json({ error: "找不到这条工具记录" }, 404);
      return json({ toolCall: record });
    }

    const conversationId = params.get("conversationId");
    const toolCalls = conversationId
      ? repo.listToolCallsByConversation(conversationId)
      : repo.listToolCalls(100);
    return json({ toolCalls });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJson<{ id?: string; undo?: boolean }>(request);
    if (!body?.id) return json({ error: "缺少 id" }, 400);
    if (!body.undo) return json({ error: "缺少 undo 标记" }, 400);

    const result = undoToolCall(body.id);
    if (!result.ok) return json({ error: result.message }, 400);
    return json({ result });
  } catch (err) {
    return serverError(err);
  }
}
