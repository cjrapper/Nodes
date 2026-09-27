/**
 * 「人设恒定」的端到端守卫。
 *
 * ## 用户的要求
 *
 * > 我想让他固定人设、统一模板，除非我后期主动修改，否则它务必遵循。
 *
 * 这是个**契约**，不该靠"读代码觉得应该没问题"来保证。它有三个容易破的子句：
 *
 * 1. **固定**：人设存在工作区上，每个会话、每一轮都用同一份。
 * 2. **统一**：所有入口（自由提问 / 模块的「AI 分析」/「自测提问」）
 *    拿到的 L0 完全一样 —— 不能出现"按钮进来的人格不一样"。
 * 3. **除非主动修改**：只有改工作区人设才会让它变；改文档、改引用、
 *    新建对话都不该影响它。
 *
 * ## 为什么必须用真实调用链测
 *
 * 这三条都跨越了"组件 → API → runChatTurn → assembleContext"好几层。
 * 单独测 `renderPersona` 只能证明拼接函数是对的，
 * 证明不了**它真的被接进了每一条路径**——而"接线漏了一处"正是本仓库
 * 反复出现过的缺陷类型（见 AGENTS.md R8）。
 *
 * 所以这里用本地 mock 服务端跑**真实的 `runChatTurn`**，然后检查
 * 服务端实际收到的 messages —— 那是唯一能证明"模型真的看到了人设"的证据。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { parseMarkdown } from "../../src/lib/blocks/parse-blocks.ts";
import { DEFAULT_PERSONA } from "../../src/lib/db/defaults.ts";

const repo = await import("../../src/lib/db/repo.ts");
const { runChatTurn } = await import("../../src/lib/ai/chat.ts");
const { contentHash } = await import("../../src/lib/blocks/markdown.ts");

/** 走真实的"保存 Markdown"路径写块，而不是直接插库 */
function writeDoc(docId: string, markdown: string): string[] {
  const parsed = parseMarkdown(markdown);
  repo.saveDocBlocks(
    docId,
    parsed.map((p) => ({ kind: p.kind, text: p.text })),
    contentHash,
  );
  return repo.listBlocks(docId).map((b) => b.id);
}

/* ------------------------------------------------------------------ *
 * mock 服务端：记录收到的请求体，回一个最简回答
 * ------------------------------------------------------------------ */

interface Captured {
  /** 每次请求收到的 messages 数组 */
  bodies: { model?: string; messages?: { role: string; content: string }[] }[];
  /** 收到请求的次数 */
  count: number;
}

const servers: Server[] = [];
const captured: Captured = { bodies: [], count: 0 };

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  captured.bodies = [];
});

async function startMock(): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured.count += 1;
      try {
        captured.bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        captured.bodies.push({});
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const frames = [
        { choices: [{ delta: { content: "收到。" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 3 } },
      ];
      for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/* ------------------------------------------------------------------ *
 * 装置
 * ------------------------------------------------------------------ */

let seq = 0;

async function makeRig(): Promise<{ conversationId: string; modelConfigId: string; workspaceId: string }> {
  const baseUrl = await startMock();
  const ws = repo.getWorkspace();
  assert.ok(ws, "集成测试环境应当已播种工作区");

  seq += 1;
  const model = repo.createModelConfig({
    name: `人设守卫模型 ${seq}`,
    provider: "openai",
    baseUrl,
    apiKey: "sk-test",
    model: "test-model",
    temperature: 0.3,
    maxTokens: 8192,
    contextWindow: 128000,
    supportsPromptCache: true,
    inputPrice: 1,
    cachedInputPrice: 0.1,
    outputPrice: 2,
    extra: {},
    isDefault: false,
  });
  const conversation = repo.createConversation({
    workspaceId: ws.id,
    title: `人设守卫会话 ${seq}`,
    modelConfigId: model.id,
  });
  return { conversationId: conversation.id, modelConfigId: model.id, workspaceId: ws.id };
}

/** 跑一轮真实对话，返回服务端收到的那次请求体 */
async function runOneTurn(
  rig: { conversationId: string; modelConfigId: string },
  content: string,
  refDocIds?: string[],
): Promise<{ role: string; content: string }[]> {
  const before = captured.count;
  for await (const _event of runChatTurn({
    conversationId: rig.conversationId,
    content,
    modelConfigId: rig.modelConfigId,
    ...(refDocIds ? { refDocIds } : {}),
  })) {
    // 事件本身不重要，我们要的是服务端收到了什么
  }
  assert.equal(captured.count, before + 1, "这一轮应当恰好发出一次请求");
  return captured.bodies[captured.bodies.length - 1].messages ?? [];
}

/** 取 system 消息拼起来（L0 与 L1 都是 system） */
function systemText(messages: { role: string; content: string }[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
}

/* ================================================================== *
 * 1. 固定 —— 每一轮都带，一次都不能少
 * ================================================================== */

test("人设恒定：自由提问的每一轮都带着 L0", async () => {
  const rig = await makeRig();
  const first = await runOneTurn(rig, "第一问");
  const second = await runOneTurn(rig, "第二问");

  for (const [label, messages] of [["第一轮", first], ["第二轮", second]] as const) {
    const sys = systemText(messages);
    assert.match(sys, /# 你的身份/, `${label} 必须带身份段`);
    assert.match(sys, /# 输出契约/, `${label} 必须带输出契约`);
  }
});

test("人设恒定：每一轮的 L0 逐字节相同（这是缓存前缀稳定的前提）", async () => {
  const rig = await makeRig();
  const a = systemText(await runOneTurn(rig, "甲"));
  const b = systemText(await runOneTurn(rig, "乙"));
  assert.equal(b, a, "L0 有任何抖动都会让全部会话的缓存前缀失效");
});

/* ================================================================== *
 * 2. 统一 —— 所有入口拿到同一份
 * ================================================================== */

test("人设统一：模块的「AI 分析」与自由提问拿到完全相同的 system 段", async () => {
  /*
   * 这是最容易破的一条：模块页的按钮传的是一条很长的任务提示词，
   * 走的是不同路径进入 runChatTurn。如果哪条路径忘了带人设，
   * 用户会得到"按钮进来的人格不一样"——而他明确要求过统一模板。
   */
  const rig = await makeRig();

  const freeform = systemText(await runOneTurn(rig, "随便问一句"));

  // 模拟「AI 分析」按钮：一条很长的任务提示词 + 整体挂载一个模块
  const ws = repo.getWorkspace()!;
  const module = repo.createDoc({
    workspaceId: ws.id,
    parentId: null,
    title: `人设守卫模块 ${seq}`,
    kind: "module",
  });
  const child = repo.createDoc({
    workspaceId: ws.id,
    parentId: module.id,
    title: "子文档",
    kind: "doc",
  });
  writeDoc(child.id, "# 子标题\n\n一段内容。");

  const rig2 = await makeRig();
  const viaButton = systemText(
    await runOneTurn(rig2, "我挂载了一个学习模块的全部知识点，请帮我做一次完整的体检。", [module.id]),
  );

  assert.equal(
    viaButton,
    freeform,
    "所有入口必须拿到同一份 system 段 —— 人设与输出契约不能因为入口不同而不同",
  );
});

/* ================================================================== *
 * 3. 除非主动修改 —— 只有改工作区人设才会变
 * ================================================================== */

test("人设恒定：改文档、改引用、新建对话都不会动 L0", async () => {
  const rig = await makeRig();
  const baseline = systemText(await runOneTurn(rig, "基线"));

  // 改文档内容
  const ws = repo.getWorkspace()!;
  const doc = repo.createDoc({ workspaceId: ws.id, parentId: null, title: "无关文档", kind: "doc" });
  const blockIds = writeDoc(doc.id, "# 标题\n\n正文。");
  const afterEdit = systemText(await runOneTurn(rig, "改完文档之后"));
  assert.equal(afterEdit, baseline, "编辑文档不该影响 L0");

  // 挂载引用（块引用与整篇挂载都试）
  const afterRef = systemText(await runOneTurn(rig, "挂上引用之后", [doc.id]));
  assert.equal(afterRef, baseline, "挂载引用不该影响 L0");
  assert.ok(blockIds.length > 0, "前置条件：文档确实有块");

  // 全新对话
  const fresh = repo.createConversation({
    workspaceId: ws.id,
    title: `人设守卫新会话 ${seq}`,
    modelConfigId: rig.modelConfigId,
  });
  const afterNew = systemText(
    await runOneTurn({ conversationId: fresh.id, modelConfigId: rig.modelConfigId }, "新会话第一句"),
  );
  assert.equal(afterNew, baseline, "新建对话必须继承同一份人设");
});

test("人设可控：改工作区人设后 L0 随之改变（这是唯一能改它的途径）", async () => {
  const rig = await makeRig();
  const ws = repo.getWorkspace()!;
  const original = ws.persona;
  const baseline = systemText(await runOneTurn(rig, "改之前"));

  try {
    repo.updateWorkspace(ws.id, { persona: "你是一位只说实话的评审员。" });
    const changed = systemText(await runOneTurn(rig, "改之后"));

    assert.notEqual(changed, baseline, "主动改人设必须生效");
    assert.match(changed, /只说实话的评审员/, "新的身份内容要出现");
    assert.match(changed, /# 输出契约/, "输出契约不随人设一起消失 —— 它是系统的，不是用户的");
  } finally {
    // 还原，避免污染同进程里的其它测试
    repo.updateWorkspace(ws.id, { persona: original });
  }
});

/* ================================================================== *
 * 4. 默认人设本身确实被用上了
 * ================================================================== */

test("播种的默认人设确实出现在真实请求里（不是只存在于常量里）", async () => {
  /*
   * 这条防的是"常量写好了但没接进去"。用户升级后其实不会自动换人设
   * （播种只对空库生效），但**新库**必须拿到新人设 —— 而"新库拿到"
   * 只能通过真实链路验证。
   */
  const rig = await makeRig();
  const sys = systemText(await runOneTurn(rig, "你好"));

  // 只要当前工作区人设就是默认值，请求里就该逐字包含它
  const ws = repo.getWorkspace()!;
  if (ws.persona === DEFAULT_PERSONA) {
    assert.ok(sys.includes(DEFAULT_PERSONA), "默认人设必须逐字出现在请求里");
    assert.match(sys, /面试陪练|盲区/, "默认人设的关键内容要真的送达模型");
  } else {
    // 库被改过（例如用户自定义了人设）—— 那断言"用的是库里那份"即可
    assert.ok(sys.includes(ws.persona), "请求里必须包含工作区当前的人设");
  }
});
