/**
 * 空回复归因测试 —— "思考完了但正文是空的"必须被正确解释。
 *
 * ## 真实故障
 *
 * 用户点模块页的「AI 分析」，看着思维链一直在输出，然后戛然而止，
 * 正文一个字都没有。界面只显示：
 *
 *   模型没有返回任何内容。可能是输出被 max_tokens 截断，或服务商返回了空响应。
 *
 * 三个问题：
 *  1. **"可能"** —— 服务商其实明确告诉了我们是哪种情况（`finish_reason`），
 *     我们把它丢掉了，于是只能猜。
 *  2. **不可行动** —— 用户不知道该改什么，改到多少。
 *  3. **丢掉了已经产生的内容** —— 思维链是有参考价值的，但提示里没提。
 *
 * 根因是推理模型的**思维链与正文共用 `max_tokens`**。默认值 4096 时，
 * 「AI 分析」这类要求模型先想再写的任务很容易把预算全花在思考上。
 *
 * ## 这个文件测什么
 *
 * 用本地 mock 服务端造出四种"没有正文"的形态，跑**真实**的 `runChatTurn`，
 * 断言错误信息能区分它们、并给出对应的下一步：
 *
 *  | 形态 | finish_reason | 有思维链 | 应当说的 |
 *  | --- | --- | --- | --- |
 *  | 思考烧完预算 | `length` | 有 | 调大最大输出 / 少想一点 |
 *  | 纯截断 | `length` | 无 | 调大最大输出 |
 *  | 只想不写 | `stop` | 有 | 换问法；反复出现则查模型名 |
 *  | 真空响应 | `stop` | 无 | 模型名 / 额外参数 / 审核 |
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

/*
 * 环境守卫与 repo 都必须在工作目录被验证之后再加载 —— 与其它集成测试一致。
 * `npm run test:integration` 会先把 cwd 切到临时目录。
 */
const repo = await import("../../src/lib/db/repo.ts");
const { runChatTurn } = await import("../../src/lib/ai/chat.ts");

/* ------------------------------------------------------------------ *
 * mock 服务端：按给定的 SSE 帧序列回放
 * ------------------------------------------------------------------ */

const servers: Server[] = [];

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function startMock(frames: string[]): Promise<string> {
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      for (const frame of frames) {
        // 切成小块写出：解析器要能扛住跨 chunk 断行
        const buf = Buffer.from(`data: ${frame}\n\n`, "utf8");
        for (let i = 0; i < buf.length; i += 7) {
          res.write(buf.subarray(i, Math.min(i + 7, buf.length)));
        }
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/* ------------------------------------------------------------------ *
 * 装置：建一个绑到 mock 服务端的模型 + 一个空会话
 * ------------------------------------------------------------------ */

let seq = 0;

async function makeRig(frames: string[]): Promise<{ conversationId: string; modelConfigId: string }> {
  const baseUrl = await startMock(frames);
  const ws = repo.getWorkspace();
  assert.ok(ws, "集成测试环境应当已播种工作区");

  // id 加自增后缀：同一个进程里跑多个用例，不能互相覆盖
  seq += 1;
  const model = repo.createModelConfig({
    name: `空回复测试模型 ${seq}`,
    provider: "openai",
    baseUrl,
    apiKey: "sk-test",
    model: "test-model",
    temperature: 0.3,
    maxTokens: 4096,
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
    title: `空回复测试会话 ${seq}`,
    modelConfigId: model.id,
  });

  return { conversationId: conversation.id, modelConfigId: model.id };
}

/** 跑完一整轮，收集所有事件 */
async function runTurn(rig: { conversationId: string; modelConfigId: string }) {
  const events = [];
  for await (const event of runChatTurn({
    conversationId: rig.conversationId,
    content: "帮我分析一下这个模块",
    modelConfigId: rig.modelConfigId,
  })) {
    events.push(event);
  }
  return {
    events,
    error: events.find((e) => e.type === "error"),
    final: events.find((e) => e.type === "final"),
    reasoning: events
      .filter((e) => e.type === "reasoning")
      .map((e) => (e as { delta: string }).delta)
      .join(""),
  };
}

/* ================================================================== *
 * 1. 思考烧完预算 —— 用户实际遇到的那一种
 * ================================================================== */

test("空回复：思维链烧完预算时，说清原因并给出具体下一步", async () => {
  const rig = await makeRig([
    JSON.stringify({ choices: [{ delta: { reasoning_content: "先看模块有哪些知识点…" } }] }),
    JSON.stringify({ choices: [{ delta: { reasoning_content: "还缺性能优化这一块…" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 5000, completion_tokens: 4096 } }),
  ]);

  const turn = await runTurn(rig);
  assert.ok(turn.error, "没有正文就必须报错，不能静默成功");
  const message = turn.error.type === "error" ? turn.error.message : "";

  assert.match(message, /思考/, "必须指出是思考过程用掉了预算");
  assert.match(message, /4096/, "必须给出当前的上限值，用户才知道从哪改");
  assert.match(message, /最大输出/, "必须指明去哪个设置项改");
  assert.match(
    message,
    /65536/,
    "必须给出具体建议值 —— 「调大一点」不是可行动的建议。" +
      "（这个数字来自服务商的真实上限：DeepSeek 思考模式原生默认 64K）",
  );
  assert.match(
    message,
    /留空/,
    "还要告诉用户更彻底的解法：留空 = 不限制 —— 否则他只会把 4096 改成 8192，再撞一次",
  );
  assert.match(message, /思考内容/, "必须告诉用户已经产生的思考仍可查看（那是唯一没白花的东西）");

  // 思维链确实被推给前端了 —— 否则"可以展开查看"是假承诺
  assert.ok(turn.reasoning.length > 0, "思维链必须已经通过 reasoning 事件送出");
});

/* ================================================================== *
 * 2. 纯截断：没有思考，就是被上限切断
 * ================================================================== */

test("空回复：纯截断时指向输出上限，不扯思维链", async () => {
  const rig = await makeRig([
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 4096 } }),
  ]);

  const turn = await runTurn(rig);
  assert.ok(turn.error);
  const message = turn.error.type === "error" ? turn.error.message : "";

  assert.match(message, /截断/);
  assert.match(message, /最大输出/);
  assert.doesNotMatch(message, /思考过程用完了/, "没有思维链时不该提思考，那是误导");
});

/* ================================================================== *
 * 3. 只想不写：有思考、正常结束、但没正文
 * ================================================================== */

test("空回复：正常结束但没有正文时，提示换问法而不是让用户调参数", async () => {
  const rig = await makeRig([
    JSON.stringify({ choices: [{ delta: { reasoning_content: "嗯……" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
  ]);

  const turn = await runTurn(rig);
  assert.ok(turn.error);
  const message = turn.error.type === "error" ? turn.error.message : "";

  assert.match(message, /只返回了思考过程/, "要说清是模型没写正文，而不是被截断");
  assert.doesNotMatch(message, /最大输出/, "正常结束的情况下调上限没用，不该误导用户去调");
});

/* ================================================================== *
 * 4. 真空响应
 * ================================================================== */

test("空回复：既无正文也无思考时，报出停止原因而不是含糊的「可能截断」", async () => {
  const rig = await makeRig([
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
  ]);

  const turn = await runTurn(rig);
  assert.ok(turn.error);
  const message = turn.error.type === "error" ? turn.error.message : "";

  assert.match(message, /空响应/);
  assert.doesNotMatch(message, /可能/, "现在有 finish_reason 这个权威依据，不该再写「可能」");
});

/* ================================================================== *
 * 5. 正常回答不能被误判
 * ================================================================== */

test("正常回答：有正文时不报错，且错误归因逻辑完全不介入", async () => {
  const rig = await makeRig([
    JSON.stringify({ choices: [{ delta: { reasoning_content: "先想" } }] }),
    JSON.stringify({ choices: [{ delta: { content: "这个模块缺 3 个知识点…" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 5000, completion_tokens: 20 } }),
  ]);

  const turn = await runTurn(rig);
  assert.equal(turn.error, undefined, "有正文就不该报错");
  assert.ok(turn.final, "应当正常收尾");
});

/* ================================================================== *
 * 6. 空回复也要落库（否则用户回头看不到"当时没出结果"）
 * ================================================================== */

test("空回复：轮次仍被记录，且标记为失败（不会被当成缓存基准）", async () => {
  const rig = await makeRig([
    JSON.stringify({ choices: [{ delta: { reasoning_content: "想了很久" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
  ]);

  await runTurn(rig);

  const invocations = repo.listInvocations(rig.conversationId);
  assert.equal(invocations.length, 1, "失败的一轮也要留下记录，否则用户查不到发生过什么");
  assert.equal(invocations[0].status, "error");
  assert.ok(invocations[0].error, "失败原因要存下来");

  // 关键：失败轮次不能成为下一轮的缓存基准
  const lastOk = repo.getLastInvocation(rig.conversationId);
  assert.equal(lastOk, null, "失败的轮次不能被当成缓存基准");
});
