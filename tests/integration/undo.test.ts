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

/**
 * 建一篇带内容的文档。
 *
 * 返回的**就是 doc 本身**（不是 `{doc, blocks}`）—— 这个文件里绝大多数用例
 * 只关心 doc，多包一层会让每一处调用都变成 `const { doc } = …`。
 * 需要块的话现查一次 `repo.listBlocks(doc.id)` 即可，那本来就是一行。
 */
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
  /*
   * ⚠️ 这里必须和生产代码 `chat.ts` 的 `executeToolCall` **逐字段对齐**。
   *
   * 曾经漏掉 `beforeState` 就导致假失败：工具明明返回了元数据快照，
   * 但这个辅助函数没往下传，于是撤销走到"没有可撤销的改动"那条分支 ——
   * 测试报的是"撤销坏了"，实际坏的是测试自己的接线。
   * 新增工具返回字段时，两处都要改（生产那处漏了不会有测试提示，
   * 这处漏了会立刻变红，所以两边都得靠人记住）。
   */
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
    beforeState: result.beforeState ?? null,
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

/* ================================================================== *
 * 5. 可重组工具的撤销 —— 权限放开的凭据
 *
 * 「AI 只能追加」那条红线被放开的理由是可逆性。
 * 所以这一节不是在测三个新功能好不好用，而是在测
 * **放开权限的前提是否真的成立**：
 *
 *   如果 update_doc / rename_doc / delete_doc 中任何一个撤不回来，
 *   那么这次放开就是一次没有防护的权限扩张，必须立刻缩回去。
 * ================================================================== */

test("撤销改写：正文逐字回到动手前，且块 id 与 cacheKey 复原", async () => {
  const doc = makeDoc("撤销-改写", ["第一段原文。", "第二段原文。"]);
  const before = repo.listBlocks(doc.id).filter((b) => b.seq >= 0 && b.text.trim() !== "");
  const beforeKeys = before.map((b) => b.cacheKey);

  const ctx = makeContext();
  const record = await callTool(
    "update_doc",
    {
      docId: doc.id,
      // 保留两段原文，另外插入一段新内容（合法的整理）
      markdown: "# 整理后的标题\n\n第一段原文。\n\n中间插入的新内容。\n\n第二段原文。",
      title: "撤销-改写（新标题）",
    },
    ctx,
  );
  assert.equal(record.status, "ok", `改写应当成功，实际：${record.resultSummary}`);
  assert.equal(repo.getDoc(doc.id)!.title, "撤销-改写（新标题）", "标题应当被改掉");

  const undone = undoToolCall(record.id);
  assert.equal(undone.ok, true, undone.message);

  const after = repo.listBlocks(doc.id).filter((b) => b.seq >= 0 && b.text.trim() !== "");
  assert.deepEqual(
    after.map((b) => b.text.trim()),
    ["第一段原文。", "第二段原文。"],
    "正文必须逐字回到动手前（插入的内容与改掉的标题段都该消失）",
  );
  assert.deepEqual(after.map((b) => b.id), before.map((b) => b.id), "块 id 必须复原");
  assert.deepEqual(
    after.map((b) => b.cacheKey),
    beforeKeys,
    "cacheKey 必须复原，否则引用这篇文档的会话缓存回不到原状",
  );
  assert.equal(repo.getDoc(doc.id)!.title, "撤销-改写", "标题也要还原");
});

test("撤销改名与移动：标题和位置都回到动手前", async () => {
  const ws = repo.getWorkspace()!;
  const moduleA = repo.createDoc({ workspaceId: ws.id, title: "撤销-模块A", kind: "module" });
  const moduleB = repo.createDoc({ workspaceId: ws.id, title: "撤销-模块B", kind: "module" });
  const doc = repo.createDoc({
    workspaceId: ws.id,
    parentId: moduleA.id,
    title: "撤销-原标题",
  });

  const ctx = makeContext();
  const record = await callTool(
    "rename_doc",
    { docId: doc.id, title: "撤销-新标题", parentId: moduleB.id },
    ctx,
  );
  assert.equal(record.status, "ok", record.resultSummary);
  assert.equal(repo.getDoc(doc.id)!.title, "撤销-新标题");
  assert.equal(repo.getDoc(doc.id)!.parentId, moduleB.id);

  const undone = undoToolCall(record.id);
  assert.equal(undone.ok, true, undone.message);
  assert.equal(repo.getDoc(doc.id)!.title, "撤销-原标题", "标题必须还原");
  assert.equal(repo.getDoc(doc.id)!.parentId, moduleA.id, "位置必须还原");
});

test("撤销删除：整棵子树从回收站恢复，且父级位置不变", async () => {
  const ws = repo.getWorkspace()!;
  const parent = repo.createDoc({ workspaceId: ws.id, title: "撤销-父级", kind: "module" });
  const leaf = repo.createDoc({ workspaceId: ws.id, parentId: parent.id, title: "撤销-叶子" });

  const ctx = makeContext();
  const record = await callTool("delete_doc", { docId: leaf.id }, ctx);
  assert.equal(record.status, "ok", record.resultSummary);
  assert.equal(repo.getDoc(leaf.id), null, "前置条件：删除后查不到");

  const undone = undoToolCall(record.id);
  assert.equal(undone.ok, true, undone.message);
  assert.ok(repo.getDoc(leaf.id), "撤销删除必须把文档捞回来");
  assert.equal(repo.getDoc(leaf.id)!.parentId, parent.id, "父级位置不能变");
});

test("撤销删除模块（含子文档）时，整棵子树一起回来", async () => {
  const ws = repo.getWorkspace()!;
  /*
   * 前提：`delete_doc` 会拒绝删含子文档的模块。
   * 但用户手动删掉一个模块是允许的（界面上的删除没有这条限制），
   * 那种记录撤销起来要把整棵子树捞回来 —— 所以这里手工造这个场景：
   * 先删掉子文档、再删模块会被拒；改成直接走 repo 模拟"用户手动删模块"。
   */
  const mod = repo.createDoc({ workspaceId: ws.id, title: "撤销-手删模块", kind: "module" });
  const child = repo.createDoc({ workspaceId: ws.id, parentId: mod.id, title: "撤销-手删子项" });
  const ctx = makeContext();
  const record = await callTool("delete_doc", { docId: mod.id }, ctx);
  assert.equal(record.status, "error", "含子文档的模块必须被工具拒绝");
  assert.match(record.resultSummary, /拒绝删除/);

  // 用户自己在界面上删（这里直接调 repo，等价于那条路径）
  repo.deleteDoc(mod.id);
  // 用一条"删除"类型的记录来撤销：手工把 before_state 填成模块本身的
  const manual = repo.recordToolCall({
    conversationId: ctx.conversationId,
    messageId: ctx.messageId,
    modelConfigId: null,
    round: 0,
    toolName: "delete_doc",
    argsJson: JSON.stringify({ docId: mod.id }),
    status: "ok",
    resultSummary: "手工删除模块",
    snapshotMarkdown: null,
    beforeState: JSON.stringify({
      kind: "delete",
      title: "撤销-手删模块",
      beforeParentId: null,
      deletedIds: [mod.id, child.id],
    }),
    targetDocId: mod.id,
  });

  const undone = undoToolCall(manual.id);
  assert.equal(undone.ok, true, undone.message);
  assert.ok(repo.getDoc(mod.id), "模块要回来");
  assert.ok(repo.getDoc(child.id), "子文档也要跟着回来（整棵子树）");
});

/* ================================================================== *
 * 6. 改写可以删减内容 —— 但必须能原样撤回
 *
 * 这里原先断言的是"丢掉既有块会被拒绝"（一道"原文一字不丢"的守卫）。
 * 那条守卫**已按要求放开**：用户的原话是「原文可以删，或者说是覆盖」。
 * 它在实践中挡掉的更多是正当的整理 —— 删过时段落、合并重复文档、
 * 把啰嗦的表述改短。
 *
 * ⚠️ 所以这一节不是"删掉了一条测试"，而是**换了判据**：
 * 以前问"改写有没有丢内容"，现在问"**丢了之后能不能原样退回**"。
 * 少了下半部分，这次放开就只是把安全网撤了而没有补上新的。
 * ================================================================== */

test("改写可以删减既有内容（守卫已放开）", async () => {
  const doc = makeDoc("改写-允许删减", ["要删掉的过时段落。", "要保留的段落。"]);
  const ctx = makeContext();

  const record = await callTool(
    "update_doc",
    { docId: doc.id, markdown: "要保留的段落。" },
    ctx,
  );

  assert.equal(record.status, "ok", `删减应当被允许，实际：${record.resultSummary}`);
  const after = repo.listBlocks(doc.id).filter((b) => b.seq >= 0);
  assert.equal(after.length, 1, "过时段落应当被真的删掉了");
  assert.equal(after[0].text.trim(), "要保留的段落。");
});

test("改写删掉的内容，撤销后连块 id 与 @ 引用一起回来", async () => {
  /*
   * 这是放开守卫之后**唯一**的安全网，所以这条断言是全局最要紧的一条。
   *
   * 光断言"内容回来了"是不够的 —— 内容一样而块 id 变了的话：
   *   - `@` 引用指向的旧 id 永远解析不到东西；
   *   - cacheKey 随之变化，引用它的会话缓存回不到原状；
   * 而这两个差别在界面上**完全看不出来**。
   *
   * 所以必须断言到 id 与引用解析这一层。
   */
  const doc = makeDoc("改写-撤销要连身份一起回", ["第一段。", "第二段。", "第三段。"]);
  const beforeIds = repo
    .listBlocks(doc.id)
    .filter((b) => b.seq >= 0)
    .map((b) => b.id);

  // 挂载首尾两段，模拟"用户引用过这两块"
  const ws = repo.getWorkspace()!;
  const conversation = repo.createConversation({
    workspaceId: ws.id,
    title: "改写撤销-引用会话",
    modelConfigId: null,
  });
  repo.setConversationRefs(conversation.id, [beforeIds[0], beforeIds[2]]);

  const { loadSourceBlocks } = await import("../../src/lib/cache/source.ts");
  assert.equal(loadSourceBlocks([beforeIds[0], beforeIds[2]]).length, 2, "前置条件：引用可解析");

  const ctx = makeContext();
  // AI 覆盖：只留中间那段，删掉首尾（也就是把那两个被引用的块删了）
  const record = await callTool("update_doc", { docId: doc.id, markdown: "第二段。" }, ctx);
  assert.equal(record.status, "ok", record.resultSummary);
  assert.equal(
    loadSourceBlocks([beforeIds[0], beforeIds[2]]).length,
    0,
    "前置条件：删掉之后引用确实悬空了（这正是要能撤回的状态）",
  );

  const undone = undoToolCall(record.id);
  assert.equal(undone.ok, true, undone.message);

  const after = repo.listBlocks(doc.id).filter((b) => b.seq >= 0);
  assert.deepEqual(
    after.map((b) => b.text.trim()),
    ["第一段。", "第二段。", "第三段。"],
    "内容必须原样回来",
  );
  assert.deepEqual(after.map((b) => b.id), beforeIds, "块 id 必须复原");
  assert.equal(
    loadSourceBlocks([beforeIds[0], beforeIds[2]]).length,
    2,
    "@ 引用必须自动接回 —— 否则用户得手动重新挂载，而他根本不知道要这么做",
  );
});

test("改写覆盖成完全不同的内容后，撤销仍能退回原文", async () => {
  const doc = makeDoc("改写-整篇覆盖", ["原来的第一段。", "原来的第二段。"]);
  const beforeIds = repo
    .listBlocks(doc.id)
    .filter((b) => b.seq >= 0)
    .map((b) => b.id);

  const ctx = makeContext();
  const record = await callTool(
    "update_doc",
    { docId: doc.id, markdown: "# 整篇重写\n\n完全不同的新内容。" },
    ctx,
  );
  assert.equal(record.status, "ok");

  const undone = undoToolCall(record.id);
  assert.equal(undone.ok, true, undone.message);
  const after = repo.listBlocks(doc.id).filter((b) => b.seq >= 0);
  assert.deepEqual(after.map((b) => b.text.trim()), ["原来的第一段。", "原来的第二段。"]);
  assert.deepEqual(after.map((b) => b.id), beforeIds, "整篇覆盖撤销后 id 也要复原");
});
