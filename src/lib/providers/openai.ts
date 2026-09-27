/**
 * OpenAI 兼容适配器。
 *
 * 覆盖 OpenAI / DeepSeek / Kimi(Moonshot) / Qwen(DashScope 兼容模式) /
 * GLM / Ollama / vLLM 等一切实现了 /chat/completions 的服务。
 *
 * 缓存策略：这些服务的**自动前缀缓存**无需显式参数，只要请求体的
 * 最长公共前缀稳定即可命中。因此本适配器的职责是"不破坏前缀"——
 * 严格按传入的 messages 顺序序列化，不做任何重排或注入。
 */

import {
  describeHttpError,
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type NormalizedUsage,
  type Provider,
  type ProviderStreamEvent,
  type ResolvedModelConfig,
} from "./types";
import { joinUrl, parseJsonSafe, readSseData } from "./sse";

interface OpenAiChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** DeepSeek-R1 等推理模型的思维链字段 */
      reasoning_content?: string | null;
      reasoning?: string | null;
      /**
       * 工具调用的增量分片。
       *
       * `arguments` 是**字符串片段**，不是一个完整 JSON —— 必须按下标累积再拼接。
       * `id` / `name` 通常只在首片出现，但部分兼容网关每片都重发，
       * 所以合并时要做幂等处理（见 `toOpenAiMessages` 上方的说明）。
       */
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      /**
       * ⚠️ **刻意忽略**（见 normalizeUsage 里的说明）。
       *
       * 字段保留在类型里是为了让"我们见过它、并且决定不用它"这件事
       * 有据可查；删掉它反而会让后来者以为漏了、再补回去。
       * OpenAI 口径下它和 `cached_tokens` 出自同一笔输入，
       * 当成 cacheWrite 会重复相减。
       */
      cache_creation_tokens?: number;
    };
    /** DeepSeek 风格：命中缓存的输入 token */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    /** ⚠️ 同 `cache_creation_tokens`：刻意忽略 */
    cache_creation_input_tokens?: number;
  } | null;
}

function normalizeUsage(usage: NonNullable<OpenAiChunk["usage"]>): NormalizedUsage {
  const promptTokens = usage.prompt_tokens ?? 0;
  const details = usage.prompt_tokens_details;

  // 命中 token 的三种可能来源，优先级从具体到笼统
  let cached = details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
  if (!cached && typeof usage.prompt_cache_miss_tokens === "number") {
    // 有 miss 计数说明服务商支持缓存，命中数按差值反推
    cached = Math.max(0, promptTokens - usage.prompt_cache_miss_tokens);
  }
  cached = Math.min(cached, promptTokens);

  /*
   * ⚠️ OpenAI 兼容口径下 `cacheWriteTokens` 必须恒为 0。
   *
   * OpenAI 系的 `prompt_tokens` 是**整个输入量**，`cached_tokens` 是它的
   * 一个子集；这里没有独立的"缓存写入"桶 —— 写入是按普通输入价计的。
   *
   * 而 `computeCost` 的公式是：
   *
   *     missTokens = promptTokens - cachedTokens - cacheWriteTokens
   *
   * 这两件事放在一起就出问题：若把 `cache_creation_tokens`
   * （某些 vLLM / 兼容网关会返回它）填进 `cacheWriteTokens`，
   * 它会和 `cached_tokens` **从同一笔输入里被减两次**，于是
   * `missTokens` 被低估、费用被少算、`savedUsd` 虚高 ——
   * 用户看到的是"省了比实际更多的钱"。
   *
   * Anthropic 侧不适用这条：那边 `input_tokens` **不含**缓存读写部分，
   * 三个桶是互斥的，所以 `toNormalizedUsage` 要把它们相加才是总量。
   * 两个口径的差异就体现在这里，不能想当然照抄。
   */
  const cacheWrite = 0;

  return {
    promptTokens,
    cachedTokens: cached,
    cacheWriteTokens: cacheWrite,
    completionTokens: usage.completion_tokens ?? 0,
  };
}

/**
 * 把分层消息翻译成 OpenAI 兼容的 messages。
 *
 * ## 为什么不能简单 map 一下
 *
 * 早先这里是 `req.messages.map((m) => ({ role: m.role, content: m.content }))`。
 * 工具调用上线后那样写会**静默降级**：
 *  - assistant 的 `tool_calls` 被丢掉 → 模型看到自己"什么都没要求过"，
 *    却紧接着收到一条工具结果，于是这一轮语义全错；
 *  - `role: "tool"` 的消息被当成普通消息发出去 → 服务商多半直接 400，
 *    或者更糟：被当成 user 内容（模型看到"用户贴了一段 JSON"）。
 *
 * 这两种都不会报错，只会让模型答得莫名其妙 —— 属于最难查的一类。
 *
 * ## 判据：没有工具时输出必须与从前逐字节一致
 *
 * 历史对话的前缀缓存是按字节比对的。如果序列化形状变了（哪怕只是多一个
 * `content: null` 字段），**升级那一刻所有会话的缓存全部失效**。
 * 所以这里对普通消息严格保持 `{ role, content }` 两个键，
 * 只有真的带工具信息时才追加字段。
 */
function toOpenAiMessages(messages: readonly ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      /*
       * 工具结果。`tool_call_id` 是必填 —— 服务商靠它把结果对应回
       * assistant 那条 tool_calls 里的某一项。
       *
       * 这里不做「找不到对应 id 就丢掉」的校验：那种校验会让"模型少要一次工具"
       * 这种无害情况变成一条凭空消失的消息。真有问题时服务商会明确报错。
       */
      return {
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        content: m.content,
      };
    }

    if (m.toolCalls?.length) {
      /*
       * assistant 要求调用工具的这一条。
       *
       * ⚠️ `arguments` 用的是 `argsText` —— **原始字符串，不做 JSON.parse +
       * 重新 stringify**。重新序列化会改变空白、转义与键序，于是服务商侧
       * 按字节比前缀的缓存永远不命中，而我们本地的分层哈希仍然显示"命中"：
       * 缓存率莫名偏低，且没有任何地方报错。
       *
       * ⚠️ `reasoning_content` 必须一起回传（DeepSeek 硬约束）：
       * "for requests carrying the `tools` parameter, the `reasoning_content`
       * must be fully passed back to the API in all subsequent requests —
       * even for turns where the model did not perform a tool call.
       * If your code does not correctly pass back `reasoning_content`,
       * the API will return a 400 error."
       *
       * 不带工具时**不能**加这个字段：一是没人要求，二是多一个字段就意味着
       * 历史对话的前缀缓存全部失效（按字节比对）。
       */
      const toolTurn: Record<string, unknown> = {
        role: "assistant",
        // 纯工具调用轮正文是空的；OpenAI 兼容系普遍接受 null 或空串，
        // 用 null 更贴近官方流式响应里给出的形状
        content: m.content === "" ? null : m.content,
        tool_calls: m.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.argsText },
        })),
      };
      if (m.reasoning) toolTurn.reasoning_content = m.reasoning;
      return toolTurn;
    }

    // 普通消息：**保持两个键不变**，别在这里顺手加字段（见上面的缓存说明）
    return { role: m.role, content: m.content };
  });
}

export const openAiCompatibleProvider: Provider = {  kind: "openai",
  label: "OpenAI 兼容",
  usesExplicitCacheBreakpoints: false,

  async *chat(
    req: ChatRequest,
    config: ResolvedModelConfig,
  ): AsyncGenerator<ProviderStreamEvent> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: toOpenAiMessages(req.messages),
      stream: true,
      temperature: req.temperature ?? config.temperature,
      // 让服务商在最后一个 chunk 里带上 usage，否则拿不到缓存命中数
      stream_options: { include_usage: true },
      ...config.extra,
      ...req.extra,
    };

    /*
     * 输出上限为 null 时**整个字段都不能出现**，而且必须**主动删掉** ——
     * `typeof maxTokens === "number"` 那种写法只做到"不去设置它"，
     * 但 `...config.extra` / `...req.extra` 可能已经在上面把它写进去了
     * （用户在「额外参数」里手写过 `max_tokens`）。只判不设的后果是
     * **用户明明选了"不限制"，请求里却还带着那个数字** ——
     * 于是他会看到"我设了不限制怎么还被截断"，而配置页上一个字都不提示。
     *
     * 判据放在 extra 展开**之后**，所以设置页的值永远赢。
     */
    const maxTokens = req.maxTokens ?? config.maxTokens;
    if (typeof maxTokens === "number") body.max_tokens = maxTokens;
    else delete body.max_tokens;

    /*
     * 工具定义。同 max_tokens：判据放在 extra 展开**之后**，
     * 并且本轮没有工具时**主动删掉** extra 里可能残留的 tools ——
     * 否则用户以前手写的 tools 会在"关掉工具"之后继续生效。
     */
    if (req.tools?.length) {
      body.tools = req.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      if (req.toolChoice) body.tool_choice = req.toolChoice;
    } else {
      delete body.tools;
      delete body.tool_choice;
    }

    // 部分兼容实现（如某些 Ollama/vLLM 版本）不认识 stream_options，会 400。
    // 这里保留它，但错误信息里会明确提示，便于用户在模型配置里关掉。
    const response = await fetch(joinUrl(config.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // 提示语由 describeHttpError 统一附加（含 stream_options、模型名写错等
      // 高频错因），这里不再重复拼装
      throw new ProviderError(
        describeHttpError(response.status, text),
        response.status,
        text,
      );
    }

    if (!response.body) {
      throw new ProviderError("服务商返回了空的响应体");
    }

    let sawUsage = false;
    /** 已上报过的 finish_reason，避免重复 yield 同一个原因 */
    let finishReason = "";

    for await (const payload of readSseData(response.body)) {
      const chunk = parseJsonSafe<OpenAiChunk>(payload);
      if (!chunk) continue;

      // 服务商有时用 200 + error 载荷报错
      const maybeError = chunk as unknown as { error?: { message?: string } };
      if (maybeError.error?.message) {
        throw new ProviderError(maybeError.error.message);
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta) {
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) yield { type: "reasoning", delta: reasoning };
        if (delta.content) yield { type: "text", delta: delta.content };

        /*
         * 工具调用分片。
         *
         * 这里**只做形状转换，不做累积** —— 累积状态放在上层（`chat.ts`），
         * 因为 Anthropic 的形态不一样（`input_json_delta.partial_json`），
         * 两家各写一份累积逻辑迟早会分叉，而分叉的后果是"参数拼错了但看起来正常"。
         *
         * ⚠️ 一个真实存在的坑：部分兼容网关（以及某些 Ollama/vLLM 版本）
         * **每一片都重发 `id` 和 `name`**，而官方只在首片给。上层合并时
         * 必须对这两个字段做幂等处理，不能无脑拼接 —— 否则工具名会变成
         * "search_blockssearch_blocks"。这里原样透传，幂等由上层保证。
         */
        for (const call of delta.tool_calls ?? []) {
          yield {
            type: "tool_call_delta",
            delta: {
              index: call.index ?? 0,
              id: call.id,
              name: call.function?.name,
              argsDelta: call.function?.arguments,
            },
          };
        }
      }

      /*
       * finish_reason —— 只在非空时上报，且只报一次。
       *
       * 它是"输出为什么停了"的唯一权威来源，尤其是 `length`：
       * 推理模型把 max_tokens 全花在思维链上时，正文会是空的，
       * 而流本身完全正常 —— 不把这个信号传上去，上层就只能含糊地说
       * "可能是截断"，用户根本不知道该调什么。
       */
      if (choice?.finish_reason && choice.finish_reason !== finishReason) {
        finishReason = choice.finish_reason;
        yield { type: "finish", reason: finishReason };
      }

      if (chunk.usage) {
        sawUsage = true;
        yield { type: "usage", usage: normalizeUsage(chunk.usage) };
      }
    }

    if (!sawUsage && config.supportsPromptCache) {
      yield {
        type: "notice",
        message:
          "服务商未返回 usage，无法统计缓存命中。若该服务支持，请确认未在额外参数中禁用 stream_options。",
      };
    }

    yield { type: "done" };
  },
};
