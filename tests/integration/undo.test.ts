/**
 * 「一键撤销 AI 写入」的回归测试。
 *
 * ## 这里守的是什么
 *
 * AI 现在会真的改用户的笔记，所以"改错了能退回去"和"能写"同等重要。
 * 撤销的实现是**快照重放**：把工具动手前的整篇 markdown 用**原来的块 id**
 * 写回去。这个方案有两个容易做错的地方，各自都会**静默失效**：
 *
 *  1. **不传原块 id** → 内容看起来一模一样，`textHash` 也一样，
 *     但 `cacheKey = sha256(textHash‖id)` 变了 → 引用这篇文档的会话缓存
 *     回不到原状，@ 引用也对不上。界面上完全看不出来。
 *  2. **新建类工具没有快照** → 撤销它应当走"删掉那篇新建的文档"另一条路，
 *     而不是报错或什么都不做。
 *
 * 另外撤销本身必须**可挽回**（软删而不是硬删），否则一次误点就永久少一篇。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const repo = await import("../../src/lib/db/repo.ts");
const { contentHash } = await import("../../src/lib/blocks/markdown.ts");
const { findTool } = await import("../../src/lib/ai/tools.ts");
const { undoToolCall } = await import("../../src/lib/ai/undo.ts");

function makeContext() {
  const ws = repo.getWorkspace()!;
  /*
   * 必须建一个**真实存在**的会话，不能编一个 id。
   *
   * `tool_call.conversation_id` 有外键指向 `conversation(id)`，编造的 id 会在
   * 写审计时抛 `FOREIGN KEY constraint failed`。
   * 真实路径里会话一定存在（工具是在一轮对话里跑的），所以这样设置才是对的。
   */
  const conversation = repo.createConversation({
    workspaceId: ws.id,
    title: "撤销测试会话",
    modelConfigId: null,
  });
  return {
    conversationId: conversation.id,
    messageId: "msg_undo",
    modelConfigId: null,
    workspaceId: ws.id,
    round: 0,
  };
}

/** 建一篇带内容的文档 */
function makeDoc(title: string, paragraphs: string[]) {
  const ws = repo.getWorkspace()!;
  const doc = repo.createDoc({ workspaceId: ws.id, title });
  repo.saveDocBlocks(
    doc.id,
    paragraphs.map((text) => ({ kind: "paragraph" as const, text })),
    contentHash,
  );
  return doc;
}

/** 走真实链路：调用工具 → 记审计（和 chat.ts 里做的一样） */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ReturnType<typeof makeContext>,
) {
  const spec = findTool(name)!;
  const result = await spec.run(args, ctx);
  return repo.recordToolCall({
    conversationId: ctx.conversationId,
    messageId: ctx.messageId,
    modelConfigId: ctx.modelConfigId,
    round: 0,
    toolName: name,
    argsJson: JSON.stringify(args),
    status: result.isError ? "error" : "ok",
    resultSummary: result.summary,
    snapshotMarkdown: result.snapshotMarkdown ?? null,
    targetDocId: result.targetDocId ?? null,
  });
}

/* ================================================================== *
 * 1. append_blocks 的撤销：块 id 与 cacheKey 必须复原
 * ================================================================== */

test("撤销追加：内容、块 id、cacheKey 全部回到动手前", () => {
  const doc = makeDoc("撤销-追加", ["用户写的第一段。", "用户写的第二段。"]);
  const before = repo.listBlocks(doc.id).filter((b) => b.seq >= 0 && b.text.trim() !== "");

  const ctx = makeContext();
  return (async () => {
    const record = await callTool(
      "append_blocks",
      { docId: doc.id, markdown: "AI 追加的一段。\n\nAI 追加的第二段。" },
      ctx,
    );
    assert.equal(record.status, "ok");

    const afterAppend = repo.listBlocks(doc.id).filter((b) => b.seq >= 0 && b.text.trim() !== "");
    assert.equal(afterAppend.length, 4, "前置条件：追加后应当是 4 个块");

    const undone = undoToolCall(record.id);
    assert.equal(undone.ok, true, undone.message);

    const afterUndo = repo.listBlocks(doc.id).filter((b) => b.seq >= 0 && b.text.trim() !== "");
    assert.equal(afterUndo.length, 2, "撤销后应当回到 2 个块");
    assert.equal(
      afterUndo[0].text,
      "用户写的第一段。",
      "内容要回到动手前（AI 追加的块不应残留）",
    );

    /*
     * 最关键的一条：块 id 必须与动手前**完全一致**。
     *
     * 只对内容是不够的 —— 用新 id 写回同样能得到一模一样的文本，
     * 但 cacheKey 变了，引用这篇文档的会话缓存回不到原状，
     * 而且这个差别在界面上一个字都看不出来。
     */
    assert.deepEqual(
      afterUndo.map((b) => b.id),
      before.map((b) => b.id),
      "块 id 必须复原 —— cacheKey = sha256(textHash‖id)，id 变了缓存就回不去",
    );
    assert.deepEqual(
      afterUndo.map((b) => b.cacheKey),
      before.map((b) => b.cacheKey),
      "cacheKey 必须逐字节复原",
    );

    // 审计记录要标成已撤销（保留原记录，审计不能被抹掉）
    const reloaded = repo.getToolCall(record.id);
    assert.equal(reloaded?.status, "undone");
  })();
});

/**
 * 这个用例覆盖的是"块身份必须接回去"这个**性质**，而不是某个实现细节。
 *
 * ⚠️ 要如实记一笔：它**区分不出**撤销里那句"显式传回原块 id"有没有写。
 * 我按 R6 把那句删掉跑过，两种实现它都绿 —— 因为块身份的复原实际由
 * `repo.saveDocBlocks` 的认领算法保证（按顺序 + 内容匹配）。
 * 也就是说那句代码是冗余的，它只是为了把意图写在代码里。
 *
 * 留这个用例仍然有价值：如果哪天有人改坏了认领算法，这里会红。
 * 但**不要**把它当成"我验证了那句代码"的证据（R6 的原话：
 * 未验证过的回归测试按"可能无效"对待 —— 这里就是那个情况，明确标注出来）。
 *
 * 场景选的是"AI 写完之后用户又编辑过"，因为那是位置认领最容易失手的情形。
 */
test("AI 写入后用户又编辑过：撤销仍能把快照的块身份接回去", async () => {
  const doc = makeDoc("撤销-用户中途编辑", ["用户第一段。", "用户第二段。"]);
  const before = repo.listBlocks(doc.id).filter((b) => b.seq >= 0 && b.text.trim() !== "");

  const ctx = makeContext();
  const record = await callTool(
    "append_blocks",
    { docId: doc.id, markdown: "AI 追加的一段。" },
    ctx,
  );
  assert.equal(record.status, "ok");

  // 用户随后自己又编了一次（整篇替换语义：这次的 markdown 就是全文）
  repo.saveDocBlocks(
    doc.id,
    [
      { kind: "paragraph", text: "用户第一段。" },
      { kind: "paragraph", text: "用户第二段。" },
      { kind: "paragraph", text: "AI 追加的一段。" },
      { kind: "paragraph", text: "用户自己又补的一段。" },
    ],
    contentHash,
  );

  const undone = undoToolCall(record.id);
  assert.equal(undone.ok, true, undone.message);

  const afterUndo = repo.listBlocks(doc.id).filter((b) => b.seq >= 0 && b.text.trim() !== "");
  assert.equal(afterUndo.length, 2, "撤销后回到动手前的两个块");
  assert.deepEqual(
    afterUndo.map((b) => b.text),
    ["用户第一段。", "用户第二段。"],
  );
  assert.deepEqual(
    afterUndo.map((b) => b.id),
    before.map((b) => b.id),
    "块身份必须接回快照那一批 —— 靠位置认领在这里会失手（用户的编辑打乱了对应关系）",
  );
  assert.deepEqual(
    afterUndo.map((b) => b.cacheKey),
    before.map((b) => b.cacheKey),
    "cacheKey 必须逐字节复原，否则引用这篇文档的会话缓存回不到原状",
  );
});

test("同一次写入不能撤销两次", async () => {  const doc = makeDoc("撤销-重复", ["原有内容。"]);
  const ctx = makeContext();
  const record = await callTool("append_blocks", { docId: doc.id, markdown: "补一段。" }, ctx);

  const first = undoToolCall(record.id);
  assert.equal(first.ok, true);

  const second = undoToolCall(record.id);
  assert.equal(second.ok, false, "第二次撤销应当被拒绝");
  assert.match(second.message, /已经撤销过/);
});

/* ================================================================== *
 * 2. 新建类工具的撤销：删掉那篇新建的文档，且仍然可恢复
 * ================================================================== */

test("撤销新建文档：文档进回收站（仍然可恢复），不是永久删除", async () => {
  const ctx = makeContext();
  const record = await callTool("create_doc", { title: "撤销-新建的文档", markdown: "正文。" }, ctx);
  assert.equal(record.status, "ok");
  const docId = record.targetDocId!;
  assert.ok(repo.getDoc(docId), "前置条件：文档先要存在");

  const undone = undoToolCall(record.id);
  assert.equal(undone.ok, true, undone.message);

  assert.equal(repo.getDoc(docId), null, "撤销后不该还能查到");
  const inTrash = repo.listDeletedDocs(repo.getWorkspace()!.id).some((d) => d.id === docId);
  assert.equal(
    inTrash,
    true,
    "撤销本身必须可挽回 —— 一次误点不该永久少一篇文档（所以走软删而不是硬删）",
  );

  // 而且真的能再恢复回来
  const restored = repo.restoreDoc(docId);
  assert.ok(restored && restored.includes(docId), "应当能从回收站恢复");
  assert.ok(repo.getDoc(docId), "恢复后要能查到");
});

/* ================================================================== *
 * 3. 撤销之后可以再被 AI 追加（状态不能卡住）
 * ================================================================== */

test("撤销之后文档仍然可以正常写入（不留半死状态）", async () => {
  const doc = makeDoc("撤销-可继续", ["第一段。"]);
  const ctx = makeContext();

  const first = await callTool("append_blocks", { docId: doc.id, markdown: "AI 第一次追加。" }, ctx);
  undoToolCall(first.id);

  const second = await callTool("append_blocks", { docId: doc.id, markdown: "AI 第二次追加。" }, ctx);
  assert.equal(second.status, "ok");

  const blocks = repo.listBlocks(doc.id).filter((b) => b.seq >= 0 && b.text.trim() !== "");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "第一段。");
  assert.match(blocks[1].text, /第二次追加/);
});

/* ================================================================== *
 * 4. 边界：没有快照又没有目标文档时要说人话
 * ================================================================== */

test("找不到记录时给出可读错误，而不是抛异常", () => {
  const result = undoToolCall("tc_不存在");
  assert.equal(result.ok, false);
  assert.match(result.message, /找不到/);
});

test("目标文档已被彻底清除时，撤销给出可行动的指引", async () => {
  const ctx = makeContext();
  const record = await callTool("create_doc", { title: "撤销-已被清掉" }, ctx);
  const docId = record.targetDocId!;
  // 模拟用户手动删掉并清空回收站
  repo.deleteDoc(docId);
  repo.purgeDoc(docId);

  const undone = undoToolCall(record.id);
  assert.equal(undone.ok, false);
  assert.match(undone.message, /不存在|不在/, "要说清文档没了，而不是静默失败");
});
