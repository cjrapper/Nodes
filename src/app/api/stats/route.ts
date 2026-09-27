import { json, requireWorkspace, serverError } from "@/lib/api/http";
import { getCacheStats, listInvocations } from "@/lib/db/repo";

/**
 * 缓存仪表盘数据。
 *
 * `range` 支持 24h / 7d / 30d / all，用于观察"改了块之后命中率掉没掉"。
 */
export async function GET(request: Request) {
  try {
    const ws = requireWorkspace();
    const params = new URL(request.url).searchParams;
    const range = params.get("range") ?? "7d";
    const conversationId = params.get("conversationId");

    const sinceMs = (() => {
      const nowMs = Date.now();
      switch (range) {
        case "24h":
          return nowMs - 24 * 60 * 60 * 1000;
        case "7d":
          return nowMs - 7 * 24 * 60 * 60 * 1000;
        case "30d":
          return nowMs - 30 * 24 * 60 * 60 * 1000;
        default:
          return 0;
      }
    })();

    const stats = getCacheStats(ws.id, sinceMs);
    const recent = conversationId ? listInvocations(conversationId, 40) : [];

    return json({ stats, range, recentInvocations: recent });
  } catch (err) {
    return serverError(err);
  }
}
