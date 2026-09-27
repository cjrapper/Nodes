/**
 * 撤销一次 AI 的工具写入。
 *
 * ## 为什么"撤销"是做快照重放，而不是设计一个反向操作
 *
 * 反向操作（"把刚追加的 N 个块删掉"）看起来更精准，实际做不到：
 *  - 用户可能在 AI 写入之后自己又编辑了那篇文档，反向删除会把**他的改动**
 *    一起删掉；
 *  - 追加可能改变了块的位置与身份认领结果，反推"哪些是新的"并不可靠。
 *
 * 快照重放没有这两个问题：把动手前的整整一篇 markdown 原样写回去，
 * 结果就是"那一篇回到 AI 动手之前的样子"——语义干净，用户能预期。
 *
 * ## 交付的诚实边界（必须写清楚，否则用户会以为能时光倒流）
 *
 * 撤销会把整篇文档恢复成**工具动手前**的状态，这意味着：
 *  - 如果 AI 写入之后**你自己**又改了这篇文档，点撤销会**一并丢掉你的改动**；
 *  - 所以前端必须在确认框里把"会丢掉这之后的所有改动"说明白。
 *
 * 这不是实现缺陷，是"整篇快照"这个方案的固有代价。换成正向操作就会有
 * 上面那两个更糟的问题（悄悄吃掉用户的内容）。两害相权，取可预期的那一个。
 *
 * ## 块 id 会原样恢复
 *
 * 快照里带着原来的块 id，重放时用同一批 id 写回 —— `textHash` 与
 * `cacheKey` 因此**逐字节复原**，引用这篇文档的会话缓存也跟着回到原状。
 * 这条是"用原 id 写回则 cacheKey 复原"那个结论的落地。
 */

import * as repo from "../db/repo";
import { contentHash } from "../blocks/markdown";
import { parseMarkdown } from "../blocks/parse-blocks";

export interface UndoResult {
  ok: boolean;
  /** 回给用户的一句话 */
  message: string;
  /** 恢复到的文档 */
  docId?: string;
  /** 恢复后文档里的块 id（应当与动手前一致，缓存键才复原得了） */
  restoredBlockIds?: string[];
}

export function undoToolCall(toolCallId: string): UndoResult {
  const record = repo.getToolCall(toolCallId);
  if (!record) return { ok: false, message: "找不到这条工具记录。" };

  if (record.status === "undone") {
    return { ok: false, message: "这次操作已经撤销过了。" };
  }
  if (!record.targetDocId) {
    return { ok: false, message: "这条记录没有关联文档，无法撤销。" };
  }

  const doc = repo.getDoc(record.targetDocId);

  /*
   * 没有快照 + 目标文档不存在 → 这是"新建文档"这类操作。
   * 撤销它 = 删掉那篇新建的文档。走软删，所以仍然可恢复
   * （撤销本身也必须是可挽回的，否则一次误点就永久少一篇）。
   */
  if (record.snapshotMarkdown === null) {
    if (!doc) return { ok: false, message: "目标文档已经不存在了。" };
    repo.deleteDoc(doc.id);
    repo.markToolCallUndone(toolCallId);
    return {
      ok: true,
      message: `已撤销：删除了 AI 新建的《${doc.title || "（无标题）"}》（在回收站里，可以恢复）。`,
      docId: doc.id,
    };
  }

  if (!doc) {
    return {
      ok: false,
      message: "目标文档已经不在了（可能被删除）。先在回收站里恢复它，再撤销这次写入。",
    };
  }

  /*
   * 快照为空串 = 工具动手前那篇文档是空白的。
   * 那就把内容清空 —— `parseMarkdown("")` 得到空数组，`saveDocBlocks`
   * 会把所有既有块软删，正好等于"回到空白"。
   */
  const current = repo.listBlocks(doc.id).filter((b) => b.seq >= 0 && b.text.trim() !== "");
  const parsed = parseMarkdown(record.snapshotMarkdown);

  /*
   * ⚠️ 必须把**原来的块 id** 一起传回去，否则这次撤销只是"写了一篇内容相同的
   * 新文档"：块 id 是新的 → `cacheKey = sha256(textHash‖id)` 变了 →
   * 引用这篇文档的会话缓存不会回到原状，而且 @ 引用会对不上。
   *
   * 怎么找回原来的 id：工具是**追加**的，所以快照里的前 N 个块与当前文档的
   * 前 N 个块一一对应（`saveDocBlocks` 的块身份认领逻辑就是按顺序认领的）。
   * 用当前文档的 id 序列去配快照的块，得到的就是原 id。
   * 配不上的（理论上不该发生）留空，让 `saveDocBlocks` 发新 id ——
   * 退化成"内容对、id 新"，比直接失败好。
   */
  /*
   * 显式把**快照对应的原块 id** 交回去。
   *
   * ⚠️ 诚实说明：实测下来这一步是**冗余**的 —— 即使不传，`saveDocBlocks` 的
   * 块身份认领（按顺序 + 内容匹配）也能把 id 接回原值，两种写法测试都过。
   * 留着它是为了让"要复原的是身份、不只是文本"这件事写在代码里，
   * 而不是隐含在另一个函数的算法里 —— 但不要把它当成承重结构：
   * 真正的保证在 `repo.saveDocBlocks` 的三趟认领。
   */
  const inputs = parsed.map((block, index) => ({
    id: current[index]?.id,
    kind: block.kind,
    text: block.text,
  }));

  repo.saveDocBlocks(doc.id, inputs, contentHash, current.map((b) => b.id));
  repo.markToolCallUndone(toolCallId);

  const restoredIds = repo
    .listBlocks(doc.id)
    .filter((b) => b.seq >= 0 && b.text.trim() !== "");

  return {
    ok: true,
    message:
      `已把《${doc.title || "（无标题）"}》恢复到 AI 动手前（${inputs.length} 个知识块，` +
      `撤销掉了 ${Math.max(0, current.length - inputs.length)} 个 AI 追加的块）。` +
      `注意：AI 写入之后你自己的改动也会一起被恢复掉。`,
    docId: doc.id,
    restoredBlockIds: restoredIds.map((b) => b.id),
  };
}
