/**
 * 把数据库中的块转换成组装器需要的 SourceBlock。
 *
 * 单独成文件的原因：这里是**缓存键语义的唯一出口** ——
 * cacheKey 的算法、标题路径的拼法一旦改动，全库所有会话的缓存前缀
 * 都会失效一次。集中在一处便于评估影响面。
 */

import { createHash } from "node:crypto";

import { buildBlockPaths, computeCacheKey } from "../blocks/markdown";
import * as repo from "../db/repo";
import type { Block } from "../db/types";
import type { SourceBlock, SourceDoc } from "./layers";

/**
 * 载入指定块并补全缓存键与路径。
 *
 * @param blockIds 待载入的块 id（顺序任意）
 */
export function loadSourceBlocks(blockIds: readonly string[]): SourceBlock[] {
  if (blockIds.length === 0) return [];
  const blocks = repo.getBlocksByIds(blockIds).filter((b) => b.seq >= 0 && b.text.trim());
  if (blocks.length === 0) return [];

  // 按文档分组，以便一次性算出每块在文档内的标题路径
  const byDoc = new Map<string, Block[]>();
  for (const b of blocks) {
    const list = byDoc.get(b.docId) ?? [];
    list.push(b);
    byDoc.set(b.docId, list);
  }

  const out: SourceBlock[] = [];
  for (const [docId, docBlocks] of byDoc) {
    const doc = repo.getDoc(docId);
    const docTitle = doc?.title ?? "未命名文档";
    // 路径需要文档内**全部**块的标题层级，而不只是被引用的那些，
    // 否则引用一个二级小节下的段落时算不出正确的父级路径。
    const allBlocks = repo.listBlocks(docId).filter((b) => b.seq >= 0);
    const paths = buildBlockPaths(docTitle, allBlocks);
    const pathById = new Map<string, string>();
    allBlocks.forEach((b, index) => pathById.set(b.id, paths[index] ?? docTitle));

    for (const b of docBlocks) {
      out.push({
        id: b.id,
        docId: b.docId,
        seq: b.seq,
        kind: b.kind,
        text: b.text,
        textHash: b.textHash,
        cacheKey: computeCacheKey(b.textHash, b.id),
        docTitle,
        path: pathById.get(b.id) ?? docTitle,
      });
    }
  }

  return out;
}

/** 单个块的 SourceBlock，供 UI 预览用 */
export function buildSourceBlock(block: Block): SourceBlock | null {
  return loadSourceBlocks([block.id])[0] ?? null;
}

/**
 * 载入整篇文档（或模块，含全部后代）作为可整体挂载的内容。
 *
 * ## 为什么模块要摊平成"所有后代的块"
 *
 * 用户挂载一个模块时想表达的是"这个方向的全部内容"，而不是"这个空壳"。
 * 模块本身不写正文、只挂子文档，所以必须把整棵子树的内容都收集起来 ——
 * 否则模型看到的是一片空白，还谈什么查漏补缺。
 *
 * ## 排序与哈希的稳定性
 *
 * - 文档之间按 `cacheKey`（内容哈希 + docId）排序，与挂载顺序无关；
 * - 文档**内部**按 `seq` 排（这是阅读顺序，不能乱）。
 * 于是"同一组文档无论怎么被挂载，渲染出的文本逐字节相同"，
 * 缓存前缀才不会碎。
 */
export function loadSourceDocs(docIds: readonly string[]): SourceDoc[] {
  if (docIds.length === 0) return [];

  const out: SourceDoc[] = [];
  const seen = new Set<string>();

  for (const rootId of docIds) {
    // 模块要把整棵子树摊平；普通文档摊平后就是它自己
    for (const docId of repo.collectDocSubtree(rootId)) {
      if (seen.has(docId)) continue;
      const doc = repo.getDoc(docId);
      if (!doc) continue;

      const blocks = repo
        .listBlocks(docId)
        .filter((b) => b.seq >= 0 && b.text.trim())
        .map((b) => ({ kind: b.kind, text: b.text, textHash: b.textHash }));

      // 空文档直接跳过：挂上去只白占 token，还会让清单里多一行空条目
      if (blocks.length === 0) continue;

      /*
       * 内容哈希由**全部块的内容哈希按序合成**，而不是把正文重算一遍。
       *
       * 复用块级哈希有两个好处：与 cacheKey 体系同源（同样的内容变化
       * 引起同样的失效），以及不必把整篇正文读两遍。
       */
      const textHash = createHash("sha256")
        .update(`${docId}\u0000${blocks.map((b) => b.textHash).join("\u0001")}`, "utf8")
        .digest("hex");

      const cacheKey = createHash("sha256")
        .update(`${textHash}\u0000${docId}`, "utf8")
        .digest("hex")
        .slice(0, 16);

      seen.add(docId);
      out.push({
        docId,
        title: doc.title || (doc.kind === "module" ? "未命名模块" : "未命名文档"),
        kind: doc.kind,
        blocks: blocks.map((b) => ({ kind: b.kind, text: b.text })),
        textHash,
        cacheKey,
        blockCount: blocks.length,
      });
    }
  }

  return out;
}
