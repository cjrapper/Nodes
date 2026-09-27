import { runChatTurn, type ChatStreamEvent } from "@/lib/ai/chat";
import { json, readJson, serverError } from "@/lib/api/http";

/**
 * 对话主接口：POST + SSE 流式返回。
 *
 * 用 POST 而非 EventSource，是因为需要提交完整请求体（本轮输入、引用块、
 * 模型覆盖）。前端用 fetch + ReadableStream 读取，语义上与 EventSource 一致。
 *
 * 事件流形态：start → plan → (text|reasoning|notice)* → final | error
 * 其中 `plan` 是关键：它在**发请求之前**就把分层构成、命中预测、
 * 断点决策与失效根因推给前端，用户能实时看到"这一轮缓存会怎样"。
 */
interface ChatBody {
  conversationId?: string;
  content?: string;
  modelConfigId?: string | null;
  refBlockIds?: string[];
  /** 整体挂载的文档/模块（「查漏补缺」这类需要看全局的任务用） */
  refDocIds?: string[];
}

export async function POST(request: Request) {
  let body: ChatBody | null = null;

  try {
    body = await readJson<ChatBody>(request);
  } catch (err) {
    return serverError(err);
  }

  if (!body?.conversationId) return json({ error: "缺少 conversationId" }, 400);
  if (!body.content || !body.content.trim()) return json({ error: "内容不能为空" }, 400);

  const encoder = new TextEncoder();
  const conversationId = body.conversationId;
  const content = body.content;
  const modelConfigId = body.modelConfigId;
  const refBlockIds = body.refBlockIds;
  const refDocIds = body.refDocIds;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: ChatStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // 客户端已断开，后续事件直接丢弃
          closed = true;
        }
      };

      try {
        for await (const event of runChatTurn({
          conversationId,
          content,
          modelConfigId,
          refBlockIds,
          refDocIds,
          signal: request.signal,
        })) {
          send(event);
        }
      } catch (err) {
        // 客户端主动中止不算错误，不必回报
        if (!request.signal.aborted) {
          send({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // 已经关闭
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // 关掉反向代理的缓冲，否则流式会被攒成一整块才发出
      "X-Accel-Buffering": "no",
    },
  });
}
