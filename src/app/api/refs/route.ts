import { json, readJson, serverError } from "@/lib/api/http";
import { loadSourceBlocks } from "@/lib/cache/source";
import * as repo from "@/lib/db/repo";

/**
 * 按 id 批量取知识块的可读信息。
 *
 * 用途：会话里只存了块的 id，界面上要显示成"文档 › 小节 + 内容摘要"。
 * 走这个接口而不是搜索接口，是因为搜索接口按文本匹配，而这里要的是
 * **精确 id 命中** —— 块内容后来被改过时，仍然要能定位到它。
 */
export async function POST(request: Request) {
  try {
    const body = await readJson<{ blockIds?: string[] }>(request);
    const ids = body?.blockIds ?? [];
    if (ids.length === 0) return json({ blocks: [] });

    // 上限保护：避免一次请求拉太多块把响应撑爆
    const limited = ids.slice(0, 200);
    const sources = loadSourceBlocks(limited);
    const byId = new Map(sources.map((s) => [s.id, s]));

    return json({
      blocks: limited.map((blockId) => {
        const source = byId.get(blockId);
        if (!source) {
          // 块可能已被删除，或内容被清空。标记 missing 让前端剔除掉。
          const existing = repo.getBlock(blockId);
          return {
            blockId,
            path: "",
            snippet: existing ? "（内容为空）" : "（块已被删除）",
            cacheKey: "",
            kind: existing?.kind ?? "paragraph",
            refCount: repo.countBlockReferences(blockId),
            missing: true,
          };
        }
        return {
          blockId,
          path: source.path,
          snippet: source.text.replace(/\s+/g, " ").trim().slice(0, 60),
          cacheKey: source.cacheKey,
          kind: source.kind,
          refCount: repo.countBlockReferences(blockId),
          missing: false,
        };
      }),
    });
  } catch (err) {
    return serverError(err);
  }
}
