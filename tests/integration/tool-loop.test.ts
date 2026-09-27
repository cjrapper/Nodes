/**
 * 多轮工具调用的端到端回归测试。
 *
 * ## 这里守的是什么
 *
 * 「全自动整理知识」的完整链路：模型请求工具 → 真的执行 → 结果回传 →
 * 模型继续。这条链路上每一步都可能**静默失效**：
 *
 *  - 第二轮请求没带 `role:"tool"` + `tool_call_id` → 服务商 400，或者更糟：
 *    模型把工具结果当成普通用户消息，答得莫名其妙；
 *  - 参数被重新序列化（`JSON.parse` 再 `stringify`）→ 键序变了 →
 *    服务商侧前缀缓存永远不命中，而本地预测仍显示"命中"；
 *  - 没带 `reasoning_content` → DeepSeek 直接 400（带 tools 时的硬约束）；
 *  - 模型反复要求调工具 → 没有上限就会一直烧钱，而界面只是在转圈。
 *
 * 所以断言必须落在**真实发出的请求体**上，而不是"函数返回了"。
 * 这个文件用本地 mock SSE 服务端抓真实请求，跑真实的 `runChatTurn`。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

const repo = await import("../../src/lib/db/repo.ts");
const { runChatTurn } = await import("../../src/lib/ai/chat.ts");

interface Captured {
  body: Record<string, unknown>;
}

/**
 * 起一个 mock 服务端：**按第几次请求**返回不同的帧序列。
 *
 * 这是与 `providers.test.ts` 里那个 mock 的关键差异 —— 那个每次请求都回放
 * 同一份 frames、且只保留最后一次请求体，所以**测不了多轮**。
 * 多轮测试必须能造出"第一轮要工具、第二轮给正文"这种序列。
 */
async function startSequenceMock(framesPerCall: string[][]) {
  const captured: Captured[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        captured.push({
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        });
      } catch {
        captured.push({ body: {} });
      }

      const frames = framesPerCall[captured.length - 1] ?? framesPerCall.at(-1) ?? [];
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      for (const frame of frames) res.write(`data: ${frame}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 建一个可用的模型配置 + 会话，指向 mock 服务端 */
function makeRig(baseUrl: string, seq: number) {
  const ws = repo.getWorkspace()!;
  const model = repo.createModelConfig({
    name: `工具测试模型 ${seq}`,
    provider: "openai",
    baseUrl,
    apiKey: "sk-test",
    model: "test-model",
    temperature: 0.3,
    // 留空 = 不限制（与上一轮改动一致）
    maxTokens: null,
    contextWindow: 128000,
    supportsPromptCache: false,
    inputPrice: 0,
    cachedInputPrice: 0,
    outputPrice: 0,
    extra: {},
    isDefault: false,
  });
  const conversation = repo.createConversation({
    workspaceId: ws.id,
    title: `工具测试会话 ${seq}`,
    modelConfigId: model.id,
  });
  return { conversationId: conversation.id, modelConfigId: model.id, workspaceId: ws.id };
}

async function runTurn(rig: { conversationId: string; modelConfigId: string }) {
  const events: unknown[] = [];
  for await (const event of runChatTurn({
    conversationId: rig.conversationId,
    content: "帮我整理一下这个方向的知识",
    modelConfigId: rig.modelConfigId,
  })) {
    events.push(event);
  }
  return events as {
    type: string;
    message?: string;
    round?: number;
    result?: {
      tools: { name: string; summary: string; status: string; targetDocId: string | null }[];
      warnings: string[];
      content: string;
    };
  }[];
}

/** 造一帧工具调用的分片 */
function toolCallFrame(index: number, id: string, name: string, argsFragment: string) {
  return JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            { index, id, type: "function", function: { name, arguments: argsFragment } },
          ],
        },
      },
    ],
  });
}

function toolFinishFrame() {
  return JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
}

/** 造一帧思维链（DeepSeek 的 reasoning_content 走这个字段） */
function reasoningFrame(text: string) {
  return JSON.stringify({ choices: [{ delta: { reasoning_content: text } }] });
}

function textFrame(text: string) {
  return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

function stopFrame() {
  return JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] });
}

/* ================================================================== *
 * 1. 完整链路：模型要工具 → 真的执行 → 结果回传 → 模型给出正文
 * ================================================================== */

test("模型请求 create_doc：真的建出文档，并把结果回传进第二轮请求", async () => {
  const before = repo.listDocs(repo.getWorkspace()!.id).length;

  const mock = await startSequenceMock([
    // 第 1 轮：先想、再要求建一篇文档（参数分两片到达，模拟真实分片）
    [
      reasoningFrame("用户想整理这个方向，我先看看有没有现成的文档…"),
      toolCallFrame(0, "call_create_1", "create_doc", '{"title": "工具E2E-新建'),
      toolCallFrame(0, "", "", '文档", "markdown": "第一段正文。"}'),
      toolFinishFrame(),
    ],
    // 第 2 轮：模型拿到工具结果后给出正文
    [textFrame("已经帮你建好了。"), stopFrame()],
  ]);

  try {
    const rig = makeRig(mock.baseUrl, 1);
    const events = await runTurn(rig);

    // ---- 断言 1：工具真实产生了副作用（不是"看起来执行了"）----
    const docs = repo.listDocs(repo.getWorkspace()!.id);
    assert.equal(docs.length, before + 1, "应当多出一篇文档");
    const created = docs.find((d) => d.title === "工具E2E-新建文档");
    assert.ok(created, "标题应当是分片拼接后的完整标题");
    assert.equal(created.icon, "sparkles", "AI 建的文档要能被认出来");
    assert.ok(
      repo.listBlocks(created.id).filter((b) => b.text.trim() !== "").length > 0,
      "正文应当被真的写进块表",
    );

    // ---- 断言 2：事件流里能看出发生了什么（前端据此渲染）----
    const starts = events.filter((e) => e.type === "tool_start");
    const results = events.filter((e) => e.type === "tool_result");
    assert.equal(starts.length, 1, "应当有 1 次 tool_start");
    assert.equal(results.length, 1, "应当有 1 次 tool_result");
    const final = events.find((e) => e.type === "final");
    assert.ok(final?.result, "应当以 final 收尾");
    assert.equal(final.result.tools.length, 1);
    assert.equal(final.result.tools[0].name, "create_doc");

    // ---- 断言 3：第二轮请求必须带上 tools 定义与 role:tool 消息 ----
    assert.equal(mock.captured.length, 2, "应当发出了两次请求（一轮工具 + 一轮正文）");

    const second = mock.captured[1].body;
    const tools = second.tools as { type: string; function: { name: string } }[];
    assert.ok(Array.isArray(tools), "第二轮也必须带 tools —— 工具集是静态的，不能按轮次裁剪");
    assert.ok(
      tools.some((t) => t.function.name === "create_doc"),
      "tools 里应当有 create_doc",
    );

    const messages = second.messages as Record<string, unknown>[];
    const toolMsg = messages.find((m) => m.role === "tool");
    assert.ok(toolMsg, "必须有一条 role:'tool' 的消息，否则模型不知道工具执行结果");
    assert.equal(toolMsg.tool_call_id, "call_create_1", "tool_call_id 必须对应上那次调用");
    assert.ok(
      typeof toolMsg.content === "string" && toolMsg.content.trim() !== "",
      "工具结果不能是空串 —— 服务商要求 content 与 tool_calls 不能同时为空",
    );

    const assistantToolMsg = messages.find((m) => Array.isArray(m.tool_calls));
    assert.ok(assistantToolMsg, "必须回传 assistant 那条带 tool_calls 的消息");
    const echoed = (assistantToolMsg.tool_calls as {
      function: { name: string; arguments: string };
    }[])[0];
    assert.equal(echoed.function.name, "create_doc");
    assert.equal(
      echoed.function.arguments,
      '{"title": "工具E2E-新建文档", "markdown": "第一段正文。"}',
      "参数必须**逐字节**回放原始串 —— 重新序列化会让服务商侧前缀缓存永远不命中，" +
        "而本地预测仍显示命中",
    );

    // 顺序：assistant(tool_calls) 必须在 tool 结果之前
    assert.ok(
      messages.indexOf(assistantToolMsg) < messages.indexOf(toolMsg),
      "assistant 的 tool_calls 必须排在它对应的 tool 结果之前",
    );

    /*
     * ⚠️ 这一条是 DeepSeek 的**硬约束**，不满足直接 400：
     *
     * "for requests carrying the `tools` parameter, the `reasoning_content`
     * must be fully passed back to the API in all subsequent requests —
     * even for turns where the model did not perform a tool call.
     * If your code does not correctly pass back `reasoning_content`,
     * the API will return a 400 error."
     *
     * 第一版测试漏了它：mock 从来没产生过思维链，于是 `m.reasoning` 恒为空、
     * 那条序列化分支根本没被走到，我把实现删掉测试照样全绿（R6 抓出来的：
     * 断言写宽了）。所以这里同时断言"有思维链"和"思维链被回传"。
     */
    assert.equal(
      typeof assistantToolMsg.reasoning_content,
      "string",
      "带 tools 的轮次必须回传 reasoning_content —— 不回传 DeepSeek 直接 400",
    );
    assert.match(
      String(assistantToolMsg.reasoning_content),
      /先看看有没有现成的文档/,
      "回传的必须是这一轮真实的思维链原文",
    );
  } finally {
    await mock.close();
  }
});

/* ================================================================== *
 * 2. 审计：每次执行都留下记录
 * ================================================================== */

test("工具执行写下审计记录（含目标文档与结果摘要）", async () => {
  const mock = await startSequenceMock([
    [
      toolCallFrame(0, "call_audit", "create_doc", '{"title": "工具E2E-审计"}'),
      toolFinishFrame(),
    ],
    [textFrame("好了。"), stopFrame()],
  ]);

  try {
    const rig = makeRig(mock.baseUrl, 2);
    await runTurn(rig);

    const audit = repo.listToolCallsByConversation(rig.conversationId);
    assert.equal(audit.length, 1, "每一次执行都要有一条审计（红线的可见性要求）");
    assert.equal(audit[0].toolName, "create_doc");
    assert.equal(audit[0].status, "ok");
    assert.equal(audit[0].round, 0);
    assert.ok(audit[0].targetDocId, "写入类工具要记下动的是哪篇文档");
    assert.match(audit[0].resultSummary, /新建/);
    assert.equal(
      audit[0].argsJson,
      '{"title": "工具E2E-审计"}',
      "审计里要保存模型给的**原始**参数串，便于复核",
    );
  } finally {
    await mock.close();
  }
});

/* ================================================================== *
 * 3. 循环上限：模型一直要工具时必须停下来
 * ================================================================== */

test("模型无限要求调工具时，撞上限就停，并给出可读提示", async () => {
  /** 每一轮都要工具，永远不给正文 */
  const endless = [
    toolCallFrame(0, "call_loop", "list_docs", "{}"),
    toolFinishFrame(),
  ];

  const mock = await startSequenceMock([endless]);

  try {
    const rig = makeRig(mock.baseUrl, 3);
    const events = await runTurn(rig);
    const final = events.find((e) => e.type === "final");

    assert.ok(final?.result, "撞上限也要正常收尾，不能挂住");
    /*
     * 上限的判据是**请求次数**，不是"工具执行次数 - 1"。
     *
     * 这两者不相等，而且差在哪很容易搞错：撞上限时循环在**执行完本轮工具之后**
     * 才发现没有下一轮了，所以"执行 5 次工具"只对应"发出 4 次后续请求"。
     * 我第一版就是按错误的公式断言的（5 !== 4），
     * 那是断言写错了，不是实现错了（R9）。
     */
    assert.ok(
      mock.captured.length <= 6,
      `请求次数必须有上限（实际 ${mock.captured.length} 次）—— ` +
        `没有上限时账单会一直涨而用户只看到界面在转圈`,
    );
    assert.ok(
      final.result.warnings.some((w) => /上限/.test(w)),
      "必须明确告诉用户撞上了工具轮次上限，否则他看到的是一段没有结论的回答",
    );

    // 每一轮最多执行一次，且轮次号从 0 连续递增 —— 这才能证明循环结构是对的
    const rounds = events
      .filter((e) => e.type === "tool_result")
      .map((e) => e.round);
    assert.deepEqual(
      rounds,
      [0, 1, 2, 3, 4],
      "应当恰好执行 5 轮，每轮一次，轮次号连续",
    );
    assert.equal(
      final.result.tools.length,
      rounds.length,
      "执行过的工具都要出现在结果里（前端据此渲染、用户据此撤销）",
    );
  } finally {
    await mock.close();
  }
});

/* ================================================================== *
 * 4. 参数残缺时绝不执行（会造成真实破坏的情形）
 * ================================================================== */

test("结束原因是 length 时不执行工具 —— 参数可能是半截的", async () => {
  const before = repo.listDocs(repo.getWorkspace()!.id).length;

  const mock = await startSequenceMock([
    [
      // 参数明显被截断（JSON 没闭合），且结束原因是 length 而不是 tool_calls
      toolCallFrame(0, "call_cut", "create_doc", '{"title": "半截的标题'),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
    ],
  ]);

  try {
    const rig = makeRig(mock.baseUrl, 4);
    await runTurn(rig);

    assert.equal(
      repo.listDocs(repo.getWorkspace()!.id).length,
      before,
      "参数残缺时绝不能执行写入工具 —— 那会真的按半个标题建出一篇文档",
    );
    const audit = repo.listToolCallsByConversation(rig.conversationId);
    assert.equal(audit.length, 0, "没执行就不该有审计记录");
  } finally {
    await mock.close();
  }
});

test("参数不是合法 JSON 时只记审计并让模型重试，不执行", async () => {
  const mock = await startSequenceMock([
    [
      toolCallFrame(0, "call_bad", "create_doc", "{这不是 JSON"),
      toolFinishFrame(),
    ],
    [textFrame("我换个方式。"), stopFrame()],
  ]);

  try {
    const rig = makeRig(mock.baseUrl, 5);
    const events = await runTurn(rig);

    const audit = repo.listToolCallsByConversation(rig.conversationId);
    assert.equal(audit.length, 1, "失败的调用**也要**记审计（只记成功会让人以为没执行过）");
    assert.equal(audit[0].status, "arg_error");

    const result = events.find((e) => e.type === "tool_result");
    assert.ok(result, "失败也要往事件流里报，否则用户不知道发生了什么");
    assert.equal((result as { isError?: boolean }).isError, true);

    // 模型必须收到一句能据此调整的话
    const second = mock.captured[1].body;
    const toolMsg = (second.messages as Record<string, unknown>[]).find(
      (m) => m.role === "tool",
    );
    assert.ok(toolMsg);
    assert.match(String(toolMsg.content), /JSON/, "要告诉模型参数不是合法 JSON");
  } finally {
    await mock.close();
  }
});

test("未知工具名不执行，并回报可用工具清单", async () => {
  const mock = await startSequenceMock([
    [
      toolCallFrame(0, "call_ghost", "delete_everything", "{}"),
      toolFinishFrame(),
    ],
    [textFrame("好的。"), stopFrame()],
  ]);

  try {
    const rig = makeRig(mock.baseUrl, 6);
    await runTurn(rig);

    const audit = repo.listToolCallsByConversation(rig.conversationId);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].status, "unknown_tool");

    const second = mock.captured[1].body;
    const toolMsg = (second.messages as Record<string, unknown>[]).find((m) => m.role === "tool");
    assert.match(
      String(toolMsg?.content),
      /list_docs|create_doc/,
      "要告诉模型有哪些工具可用，而不是只说「没有这个工具」",
    );
  } finally {
    await mock.close();
  }
});

/* ================================================================== *
 * 5. append_blocks 走完整链路：既有内容不能被改动
 * ================================================================== */

test("append_blocks 端到端：追加之后既有块一字未变", async () => {
  const ws = repo.getWorkspace()!;
  const target = repo.createDoc({ workspaceId: ws.id, title: "工具E2E-追加目标" });
  const { contentHash } = await import("../../src/lib/blocks/markdown.ts");
  repo.saveDocBlocks(
    target.id,
    [
      { kind: "paragraph", text: "用户自己写的第一段。" },
      { kind: "paragraph", text: "用户自己写的第二段。" },
    ],
    contentHash,
  );
  const before = repo.listBlocks(target.id).filter((b) => b.seq >= 0 && b.text.trim() !== "");

  const mock = await startSequenceMock([
    [
      toolCallFrame(
        0,
        "call_append",
        "append_blocks",
        `{"docId": "${target.id}", "markdown": "AI 补充的一段。"}`,
      ),
      toolFinishFrame(),
    ],
    [textFrame("补好了。"), stopFrame()],
  ]);

  try {
    const rig = makeRig(mock.baseUrl, 7);
    await runTurn(rig);

    const after = repo.listBlocks(target.id).filter((b) => b.seq >= 0 && b.text.trim() !== "");
    const afterById = new Map(after.map((b) => [b.id, b]));
    for (const block of before) {
      const kept = afterById.get(block.id);
      assert.ok(kept, `既有块 ${block.id} 不能在追加后消失`);
      assert.equal(kept.text, block.text, "既有块的文本不能被改动");
      assert.equal(kept.textHash, block.textHash, "textHash 不变 → cacheKey 不变 → 缓存不受影响");
    }
    assert.ok(
      after.some((b) => b.text.includes("AI 补充的一段")),
      "追加的内容要真的写进去",
    );

    // 写入类工具的审计要留下快照（撤销的唯一材料）
    const audit = repo.listToolCallsByConversation(rig.conversationId);
    assert.equal(audit.length, 1);
    assert.ok(
      audit[0].snapshotMarkdown?.includes("用户自己写的第一段"),
      "必须保存动手前的整篇快照 —— 那是不需要设计反向操作的撤销材料",
    );
  } finally {
    await mock.close();
  }
});
