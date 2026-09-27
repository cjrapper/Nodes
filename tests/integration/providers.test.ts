/**
 * 提供商适配器测试 —— 用真实的本地 HTTP 服务端冒充 OpenAI / Anthropic。
 *
 * 为什么不 mock `fetch`：适配器真正容易出错的地方是**逐行 SSE 解析** ——
 * 事件被切在任意字节边界、CRLF、心跳注释、`[DONE]`、以及各服务商五花八门的
 * usage 字段名。手写 mock 返回体测不出"跨 chunk 断行"这种真实问题，
 * 必须让数据真的从 socket 上流过来，并且刻意切成很小的块。
 *
 * 这些测试不联网、不需要 API Key，是 CI 里唯一能覆盖适配器逻辑的手段。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { anthropicProvider, buildAnthropicPayload } from "../../src/lib/providers/anthropic.ts";
import { openAiCompatibleProvider } from "../../src/lib/providers/openai.ts";
import {
  ProviderError,
  type ChatMessage,
  type NormalizedUsage,
  type ProviderStreamEvent,
  type ResolvedModelConfig,
} from "../../src/lib/providers/types.ts";
import { computeCost } from "../../src/lib/cache/pricing.ts";

/* ------------------------------------------------------------------ *
 * 测试用 HTTP 服务端
 * ------------------------------------------------------------------ */

const servers: Server[] = [];

after(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

interface MockOptions {
  /** 逐块写出的 SSE 帧（不含 data: 前缀与空行） */
  frames: string[];
  status?: number;
  /** 每个 frame 之间是否插入心跳注释，验证解析器忽略注释 */
  withComments?: boolean;
  /** 记录收到的请求体，供断言 */
  capture?: { body?: unknown; headers?: Record<string, string | string[] | undefined> };
  /** 每帧之间延迟毫秒，模拟真实网络 */
  delayMs?: number;
}

async function startMock(options: MockOptions): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      if (options.capture) {
        options.capture.headers = req.headers;
        try {
          options.capture.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          options.capture.body = Buffer.concat(chunks).toString("utf8");
        }
      }

      if (options.status && options.status >= 400) {
        res.writeHead(options.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock 错误" } }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });

      for (const frame of options.frames) {
        if (options.withComments) res.write(": keep-alive\n\n");
        /*
         * 关键：把每一帧切成 7 字节的小块逐个写出。
         * 真实网络下 SSE 事件几乎必然跨 TCP 包边界，解析器必须能扛住。
         * 切在 UTF-8 多字节字符中间也要能正确还原，所以这里用 Buffer 切。
         */
        const buf = Buffer.from(`data: ${frame}\n\n`, "utf8");
        for (let i = 0; i < buf.length; i += 7) {
          res.write(buf.subarray(i, Math.min(i + 7, buf.length)));
          if (options.delayMs) {
            await new Promise((r) => setTimeout(r, options.delayMs));
          }
        }
      }

      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function baseConfig(overrides: Partial<ResolvedModelConfig> = {}): ResolvedModelConfig {
  return {
    id: "mc_test",
    name: "测试模型",
    provider: "openai",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "sk-test",
    model: "test-model",
    temperature: 0.3,
    maxTokens: 1024,
    contextWindow: 128000,
    supportsPromptCache: true,
    inputPrice: 2,
    cachedInputPrice: 0.2,
    outputPrice: 8,
    extra: {},
    ...overrides,
  };
}

async function collect(
  stream: AsyncGenerator<ProviderStreamEvent>,
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "你是助手。" },
  { role: "user", content: "你好" },
];

/* ------------------------------------------------------------------ *
 * 1. OpenAI 兼容适配器
 * ------------------------------------------------------------------ */

test("OpenAI 适配器：逐块到达的 SSE 被正确还原为文本增量", async () => {
  const baseUrl = await startMock({
    frames: [
      JSON.stringify({ choices: [{ delta: { content: "发布" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "检查" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "清单" } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ],
    withComments: true,
  });

  const events = await collect(
    openAiCompatibleProvider.chat({ messages: MESSAGES }, baseConfig({ baseUrl })),
  );

  const text = events
    .filter((e): e is { type: "text"; delta: string } => e.type === "text")
    .map((e) => e.delta)
    .join("");
  assert.equal(text, "发布检查清单", "跨 chunk 的增量必须完整还原");
  assert.equal(events.at(-1)?.type, "done");
});

test("OpenAI 适配器：解析 cached_tokens 并转换为归一化用量", async () => {
  const baseUrl = await startMock({
    frames: [
      JSON.stringify({ choices: [{ delta: { content: "好" } }] }),
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 5000,
          completion_tokens: 120,
          prompt_tokens_details: { cached_tokens: 4096 },
        },
      }),
    ],
  });

  const events = await collect(
    openAiCompatibleProvider.chat({ messages: MESSAGES }, baseConfig({ baseUrl })),
  );
  const usageEvent = events.find((e) => e.type === "usage");
  assert.ok(usageEvent && usageEvent.type === "usage");
  assert.equal(usageEvent.usage.promptTokens, 5000);
  assert.equal(usageEvent.usage.cachedTokens, 4096);
  assert.equal(usageEvent.usage.completionTokens, 120);
  assert.equal(usageEvent.usage.cacheWriteTokens, 0, "自动缓存没有显式写入成本");
});

test("OpenAI 适配器：识别 DeepSeek 风格的 prompt_cache_hit_tokens", async () => {
  const baseUrl = await startMock({
    frames: [
      JSON.stringify({ choices: [{ delta: { content: "好" } }] }),
      JSON.stringify({
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: 8000,
          completion_tokens: 50,
          prompt_cache_hit_tokens: 7808,
          prompt_cache_miss_tokens: 192,
        },
      }),
    ],
  });

  const events = await collect(
    openAiCompatibleProvider.chat({ messages: MESSAGES }, baseConfig({ baseUrl })),
  );
  const usageEvent = events.find((e) => e.type === "usage");
  assert.ok(usageEvent && usageEvent.type === "usage");
  assert.equal(usageEvent.usage.cachedTokens, 7808);
});

test("OpenAI 适配器：缺少 details 时用 miss 计数反推命中量", async () => {
  const baseUrl = await startMock({
    frames: [
      JSON.stringify({
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 4000, completion_tokens: 10, prompt_cache_miss_tokens: 1000 },
      }),
    ],
  });

  const events = await collect(
    openAiCompatibleProvider.chat({ messages: MESSAGES }, baseConfig({ baseUrl })),
  );
  const usageEvent = events.find((e) => e.type === "usage");
  assert.ok(usageEvent && usageEvent.type === "usage");
  assert.equal(usageEvent.usage.cachedTokens, 3000, "4000 - 1000");
});

test("OpenAI 适配器：思维链走 reasoning 通道，不混进正文", async () => {
  const baseUrl = await startMock({
    frames: [
      JSON.stringify({ choices: [{ delta: { reasoning_content: "先想想" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "答案是 42" } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ],
  });

  const events = await collect(
    openAiCompatibleProvider.chat({ messages: MESSAGES }, baseConfig({ baseUrl })),
  );
  const reasoning = events
    .filter((e): e is { type: "reasoning"; delta: string } => e.type === "reasoning")
    .map((e) => e.delta)
    .join("");
  const text = events
    .filter((e): e is { type: "text"; delta: string } => e.type === "text")
    .map((e) => e.delta)
    .join("");

  assert.equal(reasoning, "先想想");
  assert.equal(text, "答案是 42", "思维链不应混入正文");
});

test("OpenAI 适配器：finish_reason=length 被上报 —— 截断与空响应必须能区分", async () => {
  /*
   * 这是一次真实故障的回归测试。
   *
   * 用户点「AI 分析」后看到思维链一直在输出，然后戛然而止、正文一个字都没有。
   * 根因是推理模型的思维链与正文**共用** max_tokens：思维链把 4096 烧完，
   * 正文没额度了。
   *
   * 在 finish_reason 被传上来之前，这种情况和"服务商返回了空响应"
   * 在代码里完全一样（都是一次没有 text 的正常流），错误提示只能写
   * "可能是输出被 max_tokens 截断" —— 既不确定也不可行动。
   */
  const baseUrl = await startMock({
    frames: [
      JSON.stringify({ choices: [{ delta: { reasoning_content: "用户想要一份分析…" } }] }),
      JSON.stringify({ choices: [{ delta: { reasoning_content: "再想想还缺什么…" } }] }),
      // 关键帧：正文一个字都没有，直接被上限截断
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 5000, completion_tokens: 4096 } }),
    ],
  });

  const events = await collect(
    openAiCompatibleProvider.chat({ messages: MESSAGES }, baseConfig({ baseUrl })),
  );

  const finish = events.find((e) => e.type === "finish");
  assert.ok(finish, "适配器必须把 finish_reason 上报，否则上层无法归因");
  assert.equal(finish.type === "finish" && finish.reason, "length");

  const text = events.filter((e) => e.type === "text");
  assert.equal(text.length, 0, "这一轮正文确实为空 —— 正是要复现的形态");
  const reasoning = events.filter((e) => e.type === "reasoning");
  assert.ok(reasoning.length > 0, "但思维链是有内容的");
});

test("OpenAI 适配器：正常结束时 finish_reason=stop 也被上报（且只报一次）", async () => {
  const baseUrl = await startMock({
    frames: [
      JSON.stringify({ choices: [{ delta: { content: "答" } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ],
  });

  const events = await collect(
    openAiCompatibleProvider.chat({ messages: MESSAGES }, baseConfig({ baseUrl })),
  );
  const finishes = events.filter((e) => e.type === "finish");
  assert.equal(finishes.length, 1, "同一个停止原因不该重复上报");
  assert.equal(finishes[0].type === "finish" && finishes[0].reason, "stop");
});

test("Anthropic 适配器：message_delta 上的 stop_reason=max_tokens 被上报", async () => {
  /*
   * 这条同时守住一个**具体的写法陷阱**：`message_delta` 既带 usage 又带
   * stop_reason，早先的代码是"有 usage 就处理完 continue"，stop_reason
   * 永远读不到。所以这里刻意让 usage 与 stop_reason 出现在**同一个**事件里。
   */
  const baseUrl = await startMock({
    frames: [
      JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 100 } } }),
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "先想一下…" },
      }),
      JSON.stringify({
        type: "message_delta",
        stop_reason: "max_tokens",
        usage: { output_tokens: 2048 },
      }),
    ],
  });

  const events = await collect(
    anthropicProvider.chat({ messages: MESSAGES }, baseConfig({ baseUrl, provider: "anthropic" })),
  );

  const finish = events.find((e) => e.type === "finish");
  assert.ok(finish, "usage 与 stop_reason 在同一个事件里时，stop_reason 不能被漏掉");
  assert.equal(finish.type === "finish" && finish.reason, "max_tokens");

  const usage = events.filter((e) => e.type === "usage");
  assert.ok(usage.length > 0, "同一事件里的 usage 也必须照常上报");
});

test("OpenAI 适配器：HTTP 错误抛 ProviderError 并带上状态码", async () => {  const baseUrl = await startMock({ frames: [], status: 401 });

  await assert.rejects(
    () => collect(openAiCompatibleProvider.chat({ messages: MESSAGES }, baseConfig({ baseUrl }))),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError, `应抛 ProviderError，实际 ${String(err)}`);
      assert.equal(err.status, 401);
      assert.match(err.message, /HTTP 401/);
      return true;
    },
  );
});

test("OpenAI 适配器：400 且错误体提到 stream_options 时给出关闭提示", async () => {
  /*
   * 部分 OpenAI 兼容实现（某些 Ollama / vLLM 版本）不认识 stream_options，
   * 会直接 400。这条路径必须给出可操作的提示，否则用户只会看到一个
   * 莫名其妙的 HTTP 400。这里用自定义服务端返回那种错误体。
   */
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unknown field: stream_options" } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  await assert.rejects(
    () =>
      collect(
        openAiCompatibleProvider.chat(
          { messages: MESSAGES },
          baseConfig({ baseUrl: `http://127.0.0.1:${port}` }),
        ),
      ),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.match(err.message, /stream_options/);
      assert.match(err.message, /关闭/);
      return true;
    },
  );
});

test("OpenAI 适配器：请求体保持消息顺序与角色，不改写前缀", async () => {
  const capture: { body?: unknown } = {};
  const baseUrl = await startMock({
    frames: [JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })],
    capture,
  });

  const messages: ChatMessage[] = [
    { role: "system", content: "L0 人设" },
    { role: "system", content: "L1 约定" },
    { role: "user", content: "知识块正文" },
    { role: "user", content: "本轮问题" },
  ];
  await collect(openAiCompatibleProvider.chat({ messages }, baseConfig({ baseUrl })));

  const body = capture.body as {
    messages: { role: string; content: string }[];
    stream: boolean;
    stream_options: unknown;
  };
  assert.deepEqual(
    body.messages,
    messages.map((m) => ({ role: m.role, content: m.content })),
    "消息必须原样按序发出 —— 任何重排都会摧毁前缀缓存",
  );
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  // cacheControl 是内部标记，绝不能泄漏到 OpenAI 请求体里
  assert.equal(JSON.stringify(body).includes("cacheControl"), false);
});

/* ------------------------------------------------------------------ *
 * 输出上限：null = 不限制
 * ------------------------------------------------------------------ */

/**
 * 「不限制」的判据是**字段整个不出现**，不是"填一个很大的数"。
 *
 * 两者的区别是实打实的：省略 `max_tokens` 时服务商用它自己的原生默认值
 * （DeepSeek 思考模式是 64K），而写死任何数字都只是换一个会被思维链烧完的上限。
 * 所以这条断言必须落在"键存在与否"上 —— 用 `assert.equal(body.max_tokens, undefined)`
 * 是抓不住的：`max_tokens: null` 也满足它，而 `null` 会被服务商判成 400。
 */
test("OpenAI 适配器：maxTokens 为 null 时请求体里**没有** max_tokens 这个键", async () => {
  const capture: { body?: unknown } = {};
  const baseUrl = await startMock({
    frames: [JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })],
    capture,
  });

  await collect(
    openAiCompatibleProvider.chat(
      { messages: MESSAGES },
      baseConfig({ baseUrl, maxTokens: null }),
    ),
  );

  const body = capture.body as Record<string, unknown>;
  assert.equal(
    Object.prototype.hasOwnProperty.call(body, "max_tokens"),
    false,
    "不限制时不能发送 max_tokens —— 连 null 都不能发，服务商会把它判成非法参数",
  );
  // 别的字段照旧，别把整个请求体搞坏了
  assert.equal(body.stream, true);
  assert.equal(body.model, "test-model");
});

test("OpenAI 适配器：填了数字就发送该数字，请求级覆盖优先于配置", async () => {
  const capture: { body?: unknown } = {};
  const baseUrl = await startMock({
    frames: [JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })],
    capture,
  });

  await collect(
    openAiCompatibleProvider.chat(
      { messages: MESSAGES, maxTokens: 4096 },
      baseConfig({ baseUrl, maxTokens: 65536 }),
    ),
  );

  const body = capture.body as Record<string, unknown>;
  assert.equal(body.max_tokens, 4096, "请求级的 maxTokens 应当覆盖模型配置里的值");
});

/**
 * 用户可能在「额外参数」里手写 `max_tokens`。
 *
 * 它是透传字段，所以如果不清掉，会与设置页里的值打架，而且**赢的是额外参数**
 * （它在对象展开之后）。两种情形都要能预测：填了数字就以设置为准，
 * 留空就真的不限制 —— 否则"我明明选了不限制，怎么还被截断"会再出现一次。
 */
test("OpenAI 适配器：额外参数里的 max_tokens 不会盖过设置页的值", async () => {
  const capture: { body?: unknown } = {};
  const baseUrl = await startMock({
    frames: [JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })],
    capture,
  });

  await collect(
    openAiCompatibleProvider.chat(
      { messages: MESSAGES },
      baseConfig({ baseUrl, maxTokens: 65536, extra: { max_tokens: 1 } }),
    ),
  );

  assert.equal((capture.body as Record<string, unknown>).max_tokens, 65536);
});

test("OpenAI 适配器：不限制时，额外参数里的 max_tokens 也会被清掉", async () => {
  const capture: { body?: unknown } = {};
  const baseUrl = await startMock({
    frames: [JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })],
    capture,
  });

  await collect(
    openAiCompatibleProvider.chat(
      { messages: MESSAGES },
      baseConfig({ baseUrl, maxTokens: null, extra: { max_tokens: 1 } }),
    ),
  );

  assert.equal(
    Object.prototype.hasOwnProperty.call(capture.body as object, "max_tokens"),
    false,
    "留空 = 不限制，额外参数里残留的 max_tokens 必须被清掉",
  );
});

/* ------------------------------------------------------------------ *
 * 2. Anthropic 载荷构造（断点预算逻辑）
 * ------------------------------------------------------------------ */

test("Anthropic：连续 system 消息各自成为独立块，以支持逐层断点", () => {
  const { system, messages, breakpointsUsed } = buildAnthropicPayload([
    { role: "system", content: "L0", cacheControl: { type: "ephemeral" } },
    { role: "system", content: "L1", cacheControl: { type: "ephemeral" } },
    { role: "user", content: "知识块" },
    { role: "user", content: "问题" },
  ]);

  assert.equal(system.length, 2, "两条 system 必须是两个独立块，拼成一个就没法分层缓存");
  assert.equal(system[0].cache_control?.type, "ephemeral");
  assert.equal(system[1].cache_control?.type, "ephemeral");
  assert.equal(breakpointsUsed, 2);
  assert.equal(messages.length, 1, "连续的两条 user 必须合并（Anthropic 要求角色交替）");
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content.length, 2);
});

test("Anthropic：同角色相邻消息合并时，断点标记被保留", () => {
  const { messages, breakpointsUsed } = buildAnthropicPayload([
    { role: "user", content: "历史一" },
    { role: "user", content: "历史二", cacheControl: { type: "ephemeral" } },
  ]);
  assert.equal(messages.length, 1);
  assert.equal(breakpointsUsed, 1, "合并不能把断点丢掉");
  assert.ok(messages[0].content.some((b) => b.cache_control));
});

/* ------------------------------------------------------------------ *
 * 3. Anthropic 适配器
 * ------------------------------------------------------------------ */

test("Anthropic 适配器：解析 cache_read / cache_creation 并补全输入总量", async () => {
  const baseUrl = await startMock({
    frames: [
      JSON.stringify({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 500,
            output_tokens: 1,
            cache_read_input_tokens: 4096,
            cache_creation_input_tokens: 2048,
          },
        },
      }),
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "好的" },
      }),
      JSON.stringify({
        type: "message_delta",
        usage: { output_tokens: 150 },
      }),
    ],
  });

  const events = await collect(
    anthropicProvider.chat(
      {
        messages: [
          { role: "system", content: "人设", cacheControl: { type: "ephemeral" } },
          { role: "user", content: "问题" },
        ],
      },
      baseConfig({ baseUrl, provider: "anthropic" }),
    ),
  );

  const usageEvent = events.find((e) => e.type === "usage");
  assert.ok(usageEvent && usageEvent.type === "usage");
  // Anthropic 的 input_tokens 不含缓存部分，必须补回来才是可比口径
  assert.equal(usageEvent.usage.promptTokens, 500 + 4096 + 2048);
  assert.equal(usageEvent.usage.cachedTokens, 4096);
  assert.equal(usageEvent.usage.cacheWriteTokens, 2048);

  const text = events
    .filter((e): e is { type: "text"; delta: string } => e.type === "text")
    .map((e) => e.delta)
    .join("");
  assert.equal(text, "好的");
  assert.equal(events.at(-1)?.type, "done");
});

test("Anthropic 适配器：请求体是 system 数组 + 断点，且带版本头", async () => {
  const capture: {
    body?: unknown;
    headers?: Record<string, string | string[] | undefined>;
  } = {};
  const baseUrl = await startMock({
    frames: [JSON.stringify({ type: "message_stop" })],
    capture,
  });

  await collect(
    anthropicProvider.chat(
      {
        messages: [
          { role: "system", content: "L0", cacheControl: { type: "ephemeral" } },
          { role: "user", content: "问题" },
        ],
      },
      baseConfig({ baseUrl, provider: "anthropic" }),
    ),
  );

  const body = capture.body as {
    system: { type: string; text: string; cache_control?: unknown }[];
    messages: unknown[];
  };
  assert.ok(Array.isArray(body.system), "system 必须是块数组，字符串就无法挂断点");
  assert.equal(body.system[0].text, "L0");
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
  assert.equal(capture.headers?.["anthropic-version"], "2023-06-01");
  assert.equal(capture.headers?.["x-api-key"], "sk-test");
});

/**
 * Anthropic 是唯一**没法真正做到"不限制"**的服务商：Messages API 把
 * `max_tokens` 定成必填项，省略它不是"用原生默认"而是直接 400。
 *
 * 所以这里必须做两件事，缺一不可：
 *   1. 兜一个足够大的数字，让请求能发出去；
 *   2. **明说这不是真的无上限** —— 否则用户看到的就是
 *      "我明明选了不限制，怎么还是被截断了"，而且完全无从下手。
 */
test("Anthropic 适配器：不限制时兜一个上限，并明确告知这不是真的无上限", async () => {
  const capture: { body?: unknown } = {};
  const baseUrl = await startMock({
    frames: [JSON.stringify({ type: "message_stop" })],
    capture,
  });

  const events = await collect(
    anthropicProvider.chat(
      { messages: [{ role: "user", content: "问题" }] },
      baseConfig({ baseUrl, provider: "anthropic", maxTokens: null }),
    ),
  );

  const body = capture.body as Record<string, unknown>;
  assert.equal(typeof body.max_tokens, "number", "max_tokens 是必填项，必须发一个数字");
  assert.ok(
    (body.max_tokens as number) > 0,
    "兜底值必须是正数，否则服务商直接拒绝",
  );

  const notice = events.find((e) => e.type === "notice");
  assert.ok(notice, "不限制在 Anthropic 上做不到，必须发提示而不是静默兜底");
  assert.match(
    notice.type === "notice" ? notice.message : "",
    /max_tokens/,
    "提示要说明原因（API 要求必填），否则用户不知道该改哪里",
  );
});

test("Anthropic 适配器：显式填了数字时不发那条提示", async () => {
  const baseUrl = await startMock({
    frames: [JSON.stringify({ type: "message_stop" })],
  });

  const events = await collect(
    anthropicProvider.chat(
      { messages: [{ role: "user", content: "问题" }] },
      baseConfig({ baseUrl, provider: "anthropic", maxTokens: 32000 }),
    ),
  );

  assert.equal(
    events.filter((e) => e.type === "notice").length,
    0,
    "用户已经自己填了上限，就不该再提示'无法不限制'",
  );
});

test("Anthropic 适配器：零缓存时给出可读提示而不是静默", async () => {
  const baseUrl = await startMock({
    frames: [
      JSON.stringify({
        type: "message_start",
        message: { usage: { input_tokens: 100, output_tokens: 1 } },
      }),
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }),
    ],
  });

  const events = await collect(
    anthropicProvider.chat(
      { messages: [{ role: "user", content: "问题" }] },
      baseConfig({ baseUrl, provider: "anthropic" }),
    ),
  );
  const notice = events.find((e) => e.type === "notice");
  assert.ok(notice, "缓存完全没生效时应当给出提示");
  assert.match((notice as { message: string }).message, /最小可缓存长度|1024/);
});

/* ------------------------------------------------------------------ *
 * 4. 用量 → 成本 的端到端口径
 * ------------------------------------------------------------------ */

test("从真实解析出的 usage 能算出正确的成本与节省", async () => {
  const baseUrl = await startMock({
    frames: [
      JSON.stringify({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 1000,
            output_tokens: 1,
            cache_read_input_tokens: 10000,
            cache_creation_input_tokens: 0,
          },
        },
      }),
      JSON.stringify({ type: "message_delta", usage: { output_tokens: 400 } }),
    ],
  });

  const events = await collect(
    anthropicProvider.chat(
      { messages: [{ role: "user", content: "问题" }] },
      baseConfig({ baseUrl, provider: "anthropic" }),
    ),
  );
  // 契约要求以**最后一个** usage 事件为准，所以这里取最后一个而不是 find()
  const usageEvents = events.filter(
    (e): e is { type: "usage"; usage: NormalizedUsage } => e.type === "usage",
  );
  assert.equal(usageEvents.length, 2, "Anthropic 会发两次 usage（输入侧 + 输出侧）");
  const usageEvent = usageEvents.at(-1);
  assert.ok(usageEvent && usageEvent.type === "usage");

  // Anthropic 定价：input 3 / cache read 0.3 / output 15 / cache write 3.75
  const cost = computeCost(usageEvent.usage, {
    input: 3,
    cachedInput: 0.3,
    output: 15,
    cacheWrite: 3.75,
  });

  const usage = usageEvent.usage;
  /*
   * 注意输入总量的口径：Anthropic 的 input_tokens **不含**缓存部分，
   * 适配器已经把 cache_read + cache_creation 补了回来，所以
   * promptTokens = 1000 + 10000 + 0 = 11000，其中 10000 走折扣价。
   *
   * 另一个必须知道的契约：Anthropic 会发**两次** usage（message_start 带输入侧、
   * message_delta 带输出侧）。适配器每次都发一个 usage 事件，
   * 消费者应当以**最后一个**为准 —— 这里取的就是最后一个。
   */
  assert.equal(usage.promptTokens, 11000);
  assert.equal(usage.cachedTokens, 10000);
  assert.equal(usage.cacheWriteTokens, 0, "cache_creation 为 0 就不该有写入成本");
  assert.equal(usage.completionTokens, 400, "message_delta 的输出侧必须被采纳");

  // 未命中部分 = 11000 - 10000 - 0 = 1000
  //  1000 × $3/M + 10000 × $0.3/M + 400 × $15/M
  //  = 0.003 + 0.003 + 0.006 = $0.012
  const expected = (1000 * 3 + 10000 * 0.3 + 400 * 15) / 1_000_000;
  assert.ok(Math.abs(cost.actualUsd - expected) < 1e-12, `实际 ${cost.actualUsd}`);
  assert.ok(Math.abs(cost.actualUsd - 0.012) < 1e-12, `实际 ${cost.actualUsd}`);

  const baseline = (usage.promptTokens * 3 + 400 * 15) / 1_000_000;
  assert.ok(Math.abs(cost.baselineUsd - baseline) < 1e-12);
  assert.ok(cost.savedUsd > 0);
  assert.ok(cost.hitRate > 0.9, `命中率应很高，实际 ${cost.hitRate}`);
});
