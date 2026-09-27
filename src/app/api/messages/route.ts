import { json, serverError } from "@/lib/api/http";
import * as repo from "@/lib/db/repo";

/** 读取一条会话的完整内容：消息、引用块、调用历史 */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    if (!id) return json({ error: "缺少 id 参数" }, 400);

    const conversation = repo.getConversation(id);
    if (!conversation) return json({ error: "会话不存在" }, 404);

    const messages = repo.listMessages(id);
    const refBlockIds = repo.listRefBlockIds(id);
    const refDocIds = repo.listRefDocIds(id);
    const invocations = repo.listInvocations(id, Number(params.get("invocationLimit") ?? 50));

    return json({ conversation, messages, refBlockIds, refDocIds, invocations });
  } catch (err) {
    return serverError(err);
  }
}

/** 删除某条消息及其之后的所有消息（用于"重新生成"） */
export async function DELETE(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    const seqRaw = params.get("fromSeq");
    if (!id || seqRaw === null) return json({ error: "缺少 id 或 fromSeq 参数" }, 400);
    const seq = Number(seqRaw);
    if (!Number.isFinite(seq)) return json({ error: "fromSeq 必须是数字" }, 400);
    const removed = repo.deleteMessagesFrom(id, seq);
    return json({ removed });
  } catch (err) {
    return serverError(err);
  }
}
