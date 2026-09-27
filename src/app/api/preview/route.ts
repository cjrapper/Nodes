import { previewTurn } from "@/lib/ai/chat";
import { json, readJson, serverError } from "@/lib/api/http";

/**
 * 缓存预览：只组装、不调用模型。
 *
 * 用户在真正花钱之前就能看到：
 *  - 这一轮的分层构成与 token 分布
 *  - 预期命中多少、要新写入多少
 *  - 相对上一轮是哪一层失效了、为什么
 *  - 如果换了模型 / 改了 @ 引用会损失多少缓存
 */
export async function POST(request: Request) {
  try {
    const body = await readJson<{
      conversationId?: string;
      content?: string;
      modelConfigId?: string | null;
      refBlockIds?: string[];
      refDocIds?: string[];
    }>(request);

    if (!body?.conversationId) return json({ error: "缺少 conversationId" }, 400);

    const result = previewTurn({
      conversationId: body.conversationId,
      content: body.content ?? "",
      modelConfigId: body.modelConfigId,
      refBlockIds: body.refBlockIds,
      refDocIds: body.refDocIds,
    });

    if ("error" in result) return json({ error: result.error }, 400);
    return json(result);
  } catch (err) {
    return serverError(err);
  }
}
