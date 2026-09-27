/**
 * 覆盖度统计的回归测试。
 *
 * ## 这里守的是什么
 *
 * 模块概览页的「覆盖度」= 被 AI 看过的块数 ÷ 总块数。它回答的是
 * "这个方向有多少内容被检验过" —— 只有进过上下文的内容才可能被挑错、
 * 出题、判断缺失。
 *
 * 第一版实现有个隐蔽的语义错误：挂载整个模块时，`conversation_doc_ref` 里
 * 记的是**模块自己**的 id，而内容全在子文档里。直接用
 * `block.doc_id === 挂载的 id` 去比，子文档永远匹配不上 ——
 * 于是"我用「查漏补缺」看过整个模块"被算成 0%。
 *
 * 这类错特别难发现：指标恒为 0，看起来像"还没有数据"，
 * 而不是像"算错了"。所以必须有测试钉住"挂载模块 → 子文档全部计入覆盖度"。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const repo = await import("../../src/lib/db/repo.ts");
const { contentHash } = await import("../../src/lib/blocks/markdown.ts");

/** 建一篇带内容的文档 */
function makeDoc(title: string, markdown: string, parentId: string | null = null) {
  const ws = repo.getWorkspace()!;
  const doc = repo.createDoc({ workspaceId: ws.id, parentId, title });
  const rows = markdown.split("\n\n").filter((t) => t.trim());
  repo.saveDocBlocks(
    doc.id,
    rows.map((text) => ({ kind: "paragraph" as const, text })),
    contentHash,
  );
  return doc;
}

test("没有任何引用时，覆盖度为 0 而不是缺项", () => {
  const doc = makeDoc("覆盖度-空", "第一段。\n\n第二段。");
  const coverage = repo.getDocCoverage(repo.getWorkspace()!.id);

  const entry = coverage[doc.id];
  assert.ok(entry, "没有引用的文档也应当出现在覆盖度结果里（否则界面拿不到分母）");
  assert.equal(entry.blockCount, 2);
  assert.equal(entry.referencedBlockCount, 0);
});

test("块级引用只让那一块计入覆盖度", () => {
  const doc = makeDoc("覆盖度-块级", "甲段。\n\n乙段。\n\n丙段。");
  const blocks = repo.listBlocks(doc.id);
  const conversation = repo.createConversation({
    workspaceId: repo.getWorkspace()!.id,
    title: "块级引用会话",
  });

  repo.setConversationRefs(conversation.id, [blocks[0].id]);

  const entry = repo.getDocCoverage(repo.getWorkspace()!.id)[doc.id];
  assert.equal(entry.blockCount, 3);
  assert.equal(entry.referencedBlockCount, 1, "只 @ 了一块，就只该算一块");

  repo.deleteConversation(conversation.id);
});

test("整篇挂载模块后，其下所有子文档的块全部计入覆盖度", () => {
  const module = repo.createDoc({
    workspaceId: repo.getWorkspace()!.id,
    title: "覆盖度-模块",
    kind: "module",
  });
  const childA = makeDoc("覆盖度-A", "A 一。\n\nA 二。", module.id);
  const childB = makeDoc("覆盖度-B", "B 一。", module.id);

  const beforeIds = [childA.id, childB.id];
  for (const id of beforeIds) {
    assert.equal(
      repo.getDocCoverage(repo.getWorkspace()!.id)[id]?.referencedBlockCount,
      0,
      "挂载前应当是 0",
    );
  }

  // 只挂载模块本身 —— 内容全在子文档里，这正是第一版算错的地方
  const conversation = repo.createConversation({
    workspaceId: repo.getWorkspace()!.id,
    title: "整篇挂载会话",
  });
  repo.setConversationDocRefs(conversation.id, [module.id]);

  const coverage = repo.getDocCoverage(repo.getWorkspace()!.id);
  assert.equal(
    coverage[childA.id]?.referencedBlockCount,
    coverage[childA.id]?.blockCount,
    "子文档 A 的全部块都应计入 —— 挂载模块等于看了它的整棵子树",
  );
  assert.equal(
    coverage[childB.id]?.referencedBlockCount,
    coverage[childB.id]?.blockCount,
    "子文档 B 同样",
  );

  repo.deleteConversation(conversation.id);
});

test("挂载多层模块时，深层内容也被计入", () => {
  const root = repo.createDoc({
    workspaceId: repo.getWorkspace()!.id,
    title: "覆盖度-根模块",
    kind: "module",
  });
  const mid = repo.createDoc({
    workspaceId: repo.getWorkspace()!.id,
    title: "覆盖度-子模块",
    kind: "module",
    parentId: root.id,
  });
  const leaf = makeDoc("覆盖度-叶子", "深层内容。", mid.id);

  const conversation = repo.createConversation({
    workspaceId: repo.getWorkspace()!.id,
    title: "多层挂载会话",
  });
  repo.setConversationDocRefs(conversation.id, [root.id]);

  const entry = repo.getDocCoverage(repo.getWorkspace()!.id)[leaf.id];
  assert.ok(entry, "深层文档应当出现在覆盖度结果里");
  assert.equal(
    entry.referencedBlockCount,
    entry.blockCount,
    "挂载根模块时，隔了两层的叶子文档也要算进去 —— 组装器就是这么摊平的",
  );

  repo.deleteConversation(conversation.id);
});

test("删除会话后覆盖度归零（不留脏数据）", () => {
  const doc = makeDoc("覆盖度-回收", "内容。");
  const conversation = repo.createConversation({
    workspaceId: repo.getWorkspace()!.id,
    title: "回收测试会话",
  });
  repo.setConversationDocRefs(conversation.id, [doc.id]);

  assert.ok(
    repo.getDocCoverage(repo.getWorkspace()!.id)[doc.id].referencedBlockCount > 0,
    "挂载后应当计入",
  );

  repo.deleteConversation(conversation.id);

  assert.equal(
    repo.getDocCoverage(repo.getWorkspace()!.id)[doc.id]?.referencedBlockCount ?? 0,
    0,
    "会话删了之后引用关系应当级联清掉",
  );
});

test("空文档不计入覆盖度（没有分母就没有意义）", () => {
  const empty = repo.createDoc({
    workspaceId: repo.getWorkspace()!.id,
    title: "覆盖度-空文档",
  });
  const coverage = repo.getDocCoverage(repo.getWorkspace()!.id);
  assert.equal(coverage[empty.id], undefined, "一个块都没有的文档不该出现在覆盖度里");
});

test("块数与被引用数不会超过彼此（比例不会超过 100%）", () => {
  const module = repo.createDoc({
    workspaceId: repo.getWorkspace()!.id,
    title: "覆盖度-上界",
    kind: "module",
  });
  const child = makeDoc("覆盖度-上界子", "一。\n\n二。", module.id);

  // 同时用块级和整篇两种方式挂载同一批内容 —— 最容易算出 >100% 的场景
  const conversation = repo.createConversation({
    workspaceId: repo.getWorkspace()!.id,
    title: "重复挂载会话",
    refBlockIds: repo.listBlocks(child.id).map((b) => b.id),
  });
  repo.setConversationDocRefs(conversation.id, [module.id]);

  const entry = repo.getDocCoverage(repo.getWorkspace()!.id)[child.id];
  assert.equal(entry.referencedBlockCount, entry.blockCount, "同一块只能算一次");
  assert.ok(
    entry.referencedBlockCount <= entry.blockCount,
    `被引用数(${entry.referencedBlockCount}) 不能超过总块数(${entry.blockCount})`,
  );

  repo.deleteConversation(conversation.id);
});
