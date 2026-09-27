/**
 * 文档软删除的回归测试。
 *
 * ## 这里守的是什么
 *
 * `deleteDoc` 原来是真的删：`DELETE FROM doc WHERE id = ?`，而 `block.doc_id`
 * 上有 `ON DELETE CASCADE` —— 一次误操作就永久带走一篇文档和它的全部块。
 *
 * 这个库对用户来说是**唯一不可再生**的东西（`AGENTS.md` 第五节：
 * 破坏用户数据是唯一不可接受的失败）。而当时 `doc` 表上连一个删除标记都没有，
 * 删掉就真的没了，连"事后恢复"的可能性都不存在。
 *
 * 现在改成写 `deleted_at` 时间戳。**这个改动最容易骗过测试的部分在于**：
 * 只断言"`getDoc` 返回 null"是不够的 —— 硬删也能让它返回 null，
 * 那样数据已经没了。所以每条断言都必须**同时**看两侧：
 *
 *   行为侧：查不到了（对用户来说就是"删掉了"）
 *   数据侧：行还在库里、块的旧修订也在（删错了还能救）
 *
 * 只测行为侧的测试会在"实现退回成硬删"时照样全绿，那就是一条假防护。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const repo = await import("../../src/lib/db/repo.ts");
const { contentHash } = await import("../../src/lib/blocks/markdown.ts");
const { getDb } = await import("../../src/lib/db/index.ts");

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

/** 直接读库，绕过所有读路径的过滤 —— 用来证明"数据还在" */
function rawDoc(id: string): { deleted_at: number | null } | undefined {
  return getDb()
    .prepare("SELECT deleted_at FROM doc WHERE id = ?")
    .get(id) as { deleted_at: number | null } | undefined;
}

function rawBlockCount(docId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS c FROM block WHERE doc_id = ?")
    .get(docId) as { c: number };
  return row.c;
}

test("删除文档：查不到了，但行还在库里（软删而不是硬删）", () => {
  const doc = makeDoc("软删-基础", "第一段。\n\n第二段。");
  assert.ok(repo.getDoc(doc.id), "前置条件：文档先要能被查到");

  const removed = repo.deleteDoc(doc.id);
  assert.deepEqual(removed, [doc.id], "返回值要报出被删的文档 id，前端靠它同步状态");

  // 行为侧：对用户来说就是删掉了
  assert.equal(repo.getDoc(doc.id), null, "已删的文档不能再被查到");
  assert.equal(
    repo.listDocs(doc.workspaceId).some((d) => d.id === doc.id),
    false,
    "已删的文档不能出现在列表里",
  );

  // 数据侧：这才是这个测试真正要守的东西
  const row = rawDoc(doc.id);
  assert.ok(row, "文档行必须还在库里 —— 返回 undefined 说明实现退回成硬删了");
  assert.equal(typeof row.deleted_at, "number", "deleted_at 应当是删除时刻的时间戳");
  assert.ok(
    rawBlockCount(doc.id) > 0,
    "块的正文也必须还在 —— 被 ON DELETE CASCADE 带走就没救了",
  );
});

test("删除模块：整棵子树的块都留在库里，只是都查不到了", () => {
  const parent = repo.createDoc({
    workspaceId: repo.getWorkspace()!.id,
    title: "软删-父模块",
    kind: "module",
  });
  const child = makeDoc("软删-子文档", "子文档的一段正文。", parent.id);
  const grandchild = makeDoc("软删-孙文档", "更深一层。", child.id);

  const removed = repo.deleteDoc(parent.id);
  assert.deepEqual(
    removed.sort(),
    [parent.id, child.id, grandchild.id].sort(),
    "整棵子树都要被标记，漏掉子文档就会在列表里留下孤儿",
  );

  for (const id of [parent.id, child.id, grandchild.id]) {
    assert.equal(repo.getDoc(id), null, `${id} 不应再被查到`);
    const row = rawDoc(id);
    assert.ok(row, `${id} 的行必须还在`);
    assert.equal(typeof row.deleted_at, "number", `${id} 应被标记为已删`);
  }
  assert.ok(rawBlockCount(child.id) > 0, "子文档的块必须还在库里");
  assert.ok(rawBlockCount(grandchild.id) > 0, "孙文档的块必须还在库里");
});

test("已删文档的块不参与覆盖度统计（否则分母里混着看不见的内容）", () => {
  const doc = makeDoc("软删-覆盖度", "会被统计的一段。\n\n还有一段。");
  const ws = repo.getWorkspace()!;

  const before = repo.getDocCoverage(ws.id)[doc.id];
  assert.ok(before, "前置条件：删除前它应当出现在覆盖度里");
  assert.equal(before.blockCount, 2);

  repo.deleteDoc(doc.id);

  const after = repo.getDocCoverage(ws.id)[doc.id];
  assert.equal(
    after,
    undefined,
    "已删文档不能留在覆盖度里 —— 它已经不在界面上，留在分母里会让百分比永远上不去",
  );
});

test("已删文档不进搜索结果", () => {
  const marker = "软删专用标记词XYZQ";
  const doc = makeDoc("软删-搜索", `这段含 ${marker}。`);
  assert.ok(
    repo.searchBlocks(repo.getWorkspace()!.id, marker).length > 0,
    "前置条件：删除前应当能搜到",
  );

  repo.deleteDoc(doc.id);

  assert.equal(
    repo.searchBlocks(repo.getWorkspace()!.id, marker).length,
    0,
    "删掉的文档不该还能被搜出来 —— 否则搜索会把用户引到一篇打不开的文档",
  );
});

test("删文档不碰别的文档：只动自己要删的那一棵", () => {
  const keep = makeDoc("软删-保留", `保留内容 ${"唯一标记ABCQ"}。`);
  const drop = makeDoc("软删-丢弃", "要被删掉的内容。");

  repo.deleteDoc(drop.id);

  assert.ok(repo.getDoc(keep.id), "无关文档必须原样还在");
  assert.ok(rawBlockCount(keep.id) > 0, "无关文档的块不能被牵连");
  assert.equal(rawDoc(keep.id)?.deleted_at, null, "无关文档的 deleted_at 必须还是 NULL");
});
