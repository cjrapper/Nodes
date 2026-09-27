/**
 * 服务端侧的块工具：在纯解析模块之上补上哈希与缓存键。
 *
 * 纯解析逻辑在 `./parse-blocks.ts`（前后端共用，无 Node 依赖）；
 * 本文件只负责需要 `node:crypto` 的部分，并统一 re-export，
 * 让服务端调用方仍然只 import 一个模块。
 */

import { createHash } from "node:crypto";

import {
  buildBlockPaths,
  normalizeForHash,
  parseMarkdown,
  serializeBlocks,
  type BlockKind,
  type ParsedBlock,
} from "./parse-blocks";

export {
  buildBlockPaths,
  normalizeForHash,
  parseMarkdown,
  serializeBlocks,
  type BlockKind,
  type ParsedBlock,
};

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * 块的稳定排序键。
 *
 * 混入块 id 是刻意的：两段文字完全相同的块仍然是两个独立实体，
 * 各自被引用、各自被编辑。若只用内容哈希，编辑其中一个会让另一个
 * 的排序位置一起漂移，破坏"改一块只影响一块"的局部性。
 */
export function computeCacheKey(textHash: string, id: string): string {
  return createHash("sha256")
    .update(`${textHash}\u0000${id}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/** 内容哈希 —— 规范化后再算，避免空白差异被误判为"内容变了" */
export function contentHash(text: string): string {
  return sha256Hex(normalizeForHash(text));
}

/** 取块文本的一行摘要，用于引用 chips 与清单展示 */
export function blockSummary(kind: BlockKind, text: string, maxLen = 60): string {
  let raw = text.replace(/\s+/g, " ").trim();
  if (kind === "heading") raw = raw.replace(/^#+\s*/, "");
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, maxLen - 1)}…`;
}
