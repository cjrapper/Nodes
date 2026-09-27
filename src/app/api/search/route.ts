import { json, requireWorkspace, serverError } from "@/lib/api/http";
import { computeCacheKey } from "@/lib/blocks/markdown";
import { loadSourceBlocks } from "@/lib/cache/source";
import * as repo from "@/lib/db/repo";

/** 块级搜索，供 @ 引用选择器使用 */
export async function GET(request: Request) {
  try {
    const ws = requireWorkspace();
    const params = new URL(request.url).searchParams;
    const query = (params.get("q") ?? "").trim();
    const limit = Math.min(Number(params.get("limit") ?? 30) || 30, 100);

    // 空查询返回近期更新的块，便于用户直接浏览选择
    if (!query) {
      const docs = repo.listDocs(ws.id).slice(0, 12);
      const results: {
        blockId: string;
        docId: string;
        docTitle: string;
        path: string;
        kind: string;
        cacheKey: string;
        snippet: string;
        refCount: number;
      }[] = [];
      for (const doc of docs) {
        const blocks = repo.listBlocks(doc.id).filter((b) => b.seq >= 0 && b.text.trim());
        const sources = loadSourceBlocks(blocks.slice(0, 6).map((b) => b.id));
        for (const s of sources) {
          results.push({
            blockId: s.id,
            docId: s.docId,
            docTitle: s.docTitle,
            path: s.path,
            kind: s.kind,
            cacheKey: s.cacheKey,
            snippet: s.text.replace(/\s+/g, " ").slice(0, 120),
            refCount: repo.countBlockReferences(s.id),
          });
        }
        if (results.length >= limit) break;
      }
      return json({ results: results.slice(0, limit) });
    }

    const hits = repo.searchBlocks(ws.id, query, limit);
    const sources = loadSourceBlocks(hits.map((h) => h.block.id));
    const byId = new Map(sources.map((s) => [s.id, s]));

    return json({
      results: hits.map((h) => {
        const s = byId.get(h.block.id);
        return {
          blockId: h.block.id,
          docId: h.block.docId,
          docTitle: h.docTitle,
          path: s?.path ?? h.docTitle,
          kind: h.block.kind,
          cacheKey: computeCacheKey(h.block.textHash, h.block.id),
          snippet: h.snippet,
          refCount: repo.countBlockReferences(h.block.id),
        };
      }),
    });
  } catch (err) {
    return serverError(err);
  }
}
