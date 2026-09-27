/**
 * Anthropic 原生适配器。
 *
 * 与 OpenAI 兼容系的**根本差异**：缓存需要显式声明断点
 * （最多 4 个），而不是靠自动前缀比对。这恰好与我们的分层组装完美契合 ——
 * 组装器已经在 L0/L1/L2 层末尾打好了 `cacheControl` 标记，
 * 本适配器只需把它们翻译成 Anthropic 的 block 级 `cache_control`。
 *
 * 断点预算分配（最多 4 个，按稳定性从高到低优先占用）：
 *   1. system 数组里 L0 块的末尾        —— 人设，几乎永不变
 *   2. system 数组里 L1 块的末尾        —— 工作区约定，低频变
 *   3. L2 知识块所在 user 消息的末尾     —— 被 @ 的块集合
 *   4. L3 历史倒数第二条消息的末尾       —— 让下一轮还能续上历史前缀
 *      把断点放在倒数第二条是刻意的：最后一条是 user query，
 *      下一轮它会变成倒数第二条（历史），断点会自动前移覆盖它。
 *
 * ## usage 事件契约（消费者必须知道）
 *
 * Anthropic 的用量分两次到达：`message_start` 带输入侧
 * （input / cache_read / cache_creation），`message_delta` 带输出侧
 * （output_tokens 增量）。本适配器**两次都发 usage 事件**，
 * 且每次都给出"当前已知的完整快照"而不是增量。消费者应以**最后一个**为准。
 *
 * 另外 Anthropic 的 `input_tokens` **不包含**缓存读取与写入的部分，
 * 而其他服务商的 prompt_tokens 是包含的。适配器在这里把三者相加，
 * 统一成"输入总量"口径，否则仪表盘上各家模型的命中率没法横向比较。
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
import { parseJsonSafe, readSseData } from "./sse";

/** Anthropic 的 system 块与消息内容块 */
interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
}

/** assistant 要求调用工具时，内容里出现的是这种块 */
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  /**
   * ⚠️ 这里用的是**解析后的对象**，Anthropic 要求如此（它的输入本来就是
   * 结构化的）。注意与 OpenAI 兼容系的区别：那边 `arguments` 是字符串，
   * 我们存的是原始文本并原样回放，绝不能重新序列化（见 `ToolCall.argsText`）。
   *
   * Anthropic 侧没有这个问题：官方接受对象，回放时由它自己决定怎么序列化，
   * 所以不存在"我们重排键序导致前缀逐字节不等"的风险。
   */
  input: Record<string, unknown>;
}

/** 工具执行结果回传给模型时的块 */
interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

export const ANTHROPIC_MAX_CACHE_BREAKPOINTS = 4;

/**
 * 把工具调用的**原始参数串**解析成对象。
 *
 * 解析失败时返回空对象而不是抛错：模型偶尔会给出被截断的 JSON
 * （例如恰好撞上 `max_tokens`）。那种情况下把这一轮整个搞崩，用户看到的是
 * "AI 报错了"，而实际上工具只是少了个参数 —— 工具执行层会用 schema 校验
 * 给出更可读的报错（"缺 query 参数"），比解析异常有用得多。
 */
function parseArgsObject(argsText: string): Record<string, unknown> {
  const text = argsText.trim();
  if (text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** 这次合并是否会让工具块越位（工具块必须留在 content 数组最前面） */
function hasToolBlocks(last: AnthropicMessage, msg: ChatMessage): boolean {
  if (msg.toolCalls?.length) return true;
  return last.content.some((b) => b.type === "tool_use" || b.type === "tool_result");
}

/**
 * 把我们的分层消息翻译成 Anthropic 的 (system, messages) 结构。
 *
 * 关键处理：连续的 system 消息会**各自独立**成为 system 数组里的一个块，
 * 而不是被拼接成一个大字符串 —— 只有分块才能给每层单独打断点，
 * 从而实现"改 L1 不失效 L0"。
 */
export function buildAnthropicPayload(messages: ChatMessage[]): {
  system: AnthropicTextBlock[];
  messages: AnthropicMessage[];
  /** 实际使用的断点数，用于诊断 */
  breakpointsUsed: number;
} {
  const system: AnthropicTextBlock[] = [];
  const out: AnthropicMessage[] = [];
  let breakpointsUsed = 0;

  for (const msg of messages) {
    /*
     * 工具消息走单独一条路径，**不参与下面的同角色合并**。
     *
     * 两个原因：
     *  1. 语义上 `tool_result` 必须是对某次 `tool_use` 的答复，合并进一条
     *     普通 user 文本消息之后，模型看到的是"用户在正文里贴了一段 JSON"；
     *  2. Anthropic 要求 `tool_result` 块在 content 数组**最前面**，
     *     而合并是把新块 push 到末尾 —— 顺序一错就是 400。
     */
    if (msg.role === "tool") {
      const resultBlock: AnthropicToolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.toolCallId ?? "",
        content: msg.content,
      };
      const last = out[out.length - 1];
      if (last && last.role === "user") {
        // 相邻的 user 消息可以安全地追加（工具结果在前、用户文本在后是合法的）
        last.content.push(resultBlock);
      } else {
        out.push({ role: "user", content: [resultBlock] });
      }
      continue;
    }

    const blocks: AnthropicContentBlock[] = [];
    const block: AnthropicTextBlock = { type: "text", text: msg.content };
    if (msg.cacheControl) {
      block.cache_control = msg.cacheControl;
      breakpointsUsed += 1;
    }
    // 正文为空但带工具调用时不要塞一个空文本块 —— 那会让该条消息看起来
    // 像"模型说了一句空话"，而不是"模型要求调用工具"
    if (msg.content !== "" || !msg.toolCalls?.length) blocks.push(block);
    for (const call of msg.toolCalls ?? []) {
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: parseArgsObject(call.argsText),
      });
    }

    if (msg.role === "system") {
      // system 只会是纯文本（工具调用不可能出现在 system 上）
      system.push(block);
      continue;
    }

    const last = out[out.length - 1];
    if (last && last.role === msg.role && !hasToolBlocks(last, msg)) {
      // Anthropic 要求 user/assistant 严格交替，同角色相邻消息需要合并。
      // 合并时断点标记"或"起来即可：只要有一段要求缓存，整块就打断点。
      // 注意只能给 **text 块**挂断点：给 tool_use / tool_result 挂是无效的
      // （Anthropic 只对 text 块认 cache_control），所以这里显式收窄类型。
      const lastTextBlock = [...last.content]
        .reverse()
        .find((b): b is AnthropicTextBlock => b.type === "text");
      if (block.cache_control && lastTextBlock && !lastTextBlock.cache_control) {
        lastTextBlock.cache_control = block.cache_control;
      }
      last.content.push({ type: "text", text: msg.content });
      continue;
    }

    out.push({ role: msg.role, content: blocks });
  }

  // 唯一例外：如果整段上下文里只有 system（无用户消息），Anthropic 会报错。
  // 由调用方保证至少有一条 user 消息，这里不兜底。
  return { system, messages: out, breakpointsUsed };
}

interface AnthropicStreamEvent {
  type: string;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
  /** `content_block_start` / `content_block_delta` / `content_block_stop` 上的块序号与块本身 */
  index?: number;
  content_block?: { type?: string; id?: string; name?: string; input?: unknown };
  /** `message_delta` 上的停止原因：`end_turn` / `max_tokens` / `stop_sequence` / `tool_use`… */
  stop_reason?: string | null;
  error?: { type?: string; message?: string };
}

function toNormalizedUsage(u: NonNullable<AnthropicStreamEvent["usage"]>): NormalizedUsage {
  const cached = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const base = u.input_tokens ?? 0;
  return {
    // Anthropic 的 input_tokens **不含**命中与写入部分，需要补回来才是
    // 与其他服务商可比的"输入总量"
    promptTokens: base + cached + write,
    cachedTokens: cached,
    cacheWriteTokens: write,
    completionTokens: u.output_tokens ?? 0,
  };
}

export const anthropicProvider: Provider = {
  kind: "anthropic",
  label: "Anthropic 原生",
  usesExplicitCacheBreakpoints: true,

  async *chat(
    req: ChatRequest,
    config: ResolvedModelConfig,
  ): AsyncGenerator<ProviderStreamEvent> {
    const { system, messages, breakpointsUsed } = buildAnthropicPayload(req.messages);

    if (breakpointsUsed > ANTHROPIC_MAX_CACHE_BREAKPOINTS) {
      yield {
        type: "notice",
        message: `缓存断点请求了 ${breakpointsUsed} 个，超过 Anthropic 上限 ${ANTHROPIC_MAX_CACHE_BREAKPOINTS} 个，超出部分不会生效。`,
      };
    }

    /*
     * Anthropic 与 OpenAI 兼容系有一个**不能抹平**的差异：`max_tokens` 在
     * Messages API 里是必填项，没有"省略即用原生默认"这回事。
     *
     * 所以「不限制」在 Anthropic 上只能翻译成一个足够大的数字。取 64000 的理由：
     * 它是当前 Claude 各代模型共同支持的量级（Sonnet 4.5 / Opus 4.5 的上限，
     * 而不是某个老模型的 4096）。这个值仍然可能被更老的模型拒绝，所以**必须
     * 同时发一条 notice** 告诉用户这里不是真的"无上限"，以及该往哪里改 ——
     * 否则用户看到的就是"我明明选了不限制，怎么还是被截断了"。
     */
    const fallbackMaxTokens = 64000;
    const configuredMaxTokens = req.maxTokens ?? config.maxTokens ?? null;
    const maxTokens = configuredMaxTokens ?? fallbackMaxTokens;
    if (configuredMaxTokens === null) {
      yield {
        type: "notice",
        message:
          `Anthropic 的 Messages API 要求必须给出 max_tokens，无法真正"不限制"，` +
          `本轮按 ${fallbackMaxTokens} 发送。如果仍被截断，到「模型配置」里把这个模型的` +
          `「最大输出」显式填成它支持的上限。`,
      };
    }

    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream: true,
      temperature: req.temperature ?? config.temperature,
      ...config.extra,
      ...req.extra,
    };
    // 同 openai 适配器：放在 extra 之后，确保它盖掉用户手写的值
    body.max_tokens = maxTokens;

    /*
     * 工具定义。字段名与 OpenAI 兼容系不同：Anthropic 用 `input_schema`
     * 而不是 `parameters`，所以这里要做一次形状转换（而不是把同一份对象
     * 塞给两家）。
     *
     * ⚠️ 与 openai 适配器一样，tools 必须放在 `...config.extra` / `...req.extra`
     * 之后设置，否则用户在「额外参数」里手写的 tools 会盖掉它；
     * 反过来，本轮没给工具时要**主动删掉** extra 里可能残留的 tools。
     */
    if (req.tools?.length) {
      body.tools = req.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
      if (req.toolChoice) body.tool_choice = { type: req.toolChoice };
    } else {
      delete body.tools;
      delete body.tool_choice;
    }
    if (system.length > 0) body.system = system;

    const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        // 兼容不支持 prompt caching 的老账号/网关
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(
        describeHttpError(response.status, text),
        response.status,
        text,
      );
    }

    if (!response.body) {
      throw new ProviderError("服务商返回了空的响应体");
    }

    let lastUsage: NormalizedUsage | null = null;
    /** 已上报过的停止原因，避免重复 yield */
    let finishReason = "";
    /*
     * `tool_use` 块的序号映射。
     *
     * Anthropic 的块序号是**整条消息内**的（前面还可能有 text / thinking 块），
     * 而上层要的是"这是第几个工具调用"。所以自己数一遍 `tool_use` 的个数，
     * 并把当前正在收参数的那个记为 `activeToolIndex`。
     */
    let toolIndexBase = 0;
    let toolBlockCount = 0;
    let activeToolIndex: number | null = null;
    let warnedToolIndexGap = false;

    for await (const payload of readSseData(response.body)) {
      const event = parseJsonSafe<AnthropicStreamEvent>(payload);
      if (!event) continue;

      if (event.type === "error") {
        throw new ProviderError(event.error?.message ?? "Anthropic 流式错误");
      }

      if (event.type === "message_start" && event.message?.usage) {
        lastUsage = toNormalizedUsage(event.message.usage);
        yield { type: "usage", usage: lastUsage };
        continue;
      }

      if (event.type === "message_delta") {
        /*
         * 注意这里**不能** `continue` 就走 —— `message_delta` 同时携带 usage
         * 与 stop_reason。早先的写法是"有 usage 就处理完 continue"，
         * 那样 stop_reason 永远不会被读到，于是 `max_tokens` 截断
         * （`stop_reason: "max_tokens"`）在界面上表现为"模型什么都没返回"，
         * 用户完全不知道该去调大输出上限。
         */
        if (event.stop_reason && event.stop_reason !== finishReason) {
          finishReason = event.stop_reason;
          yield { type: "finish", reason: finishReason };
        }
        if (event.usage) {
          // message_delta 通常只带 output_tokens 增量，输入侧沿用 message_start
          const deltaUsage = toNormalizedUsage(event.usage);
          lastUsage = lastUsage
            ? {
                promptTokens: lastUsage.promptTokens,
                cachedTokens: lastUsage.cachedTokens,
                cacheWriteTokens: lastUsage.cacheWriteTokens,
                completionTokens: deltaUsage.completionTokens,
              }
            : deltaUsage;
          yield { type: "usage", usage: lastUsage };
        }
        continue;
      }

      if (event.type === "content_block_delta" && event.delta) {
        if (event.delta.type === "thinking_delta" && event.delta.thinking) {
          yield { type: "reasoning", delta: event.delta.thinking };
        } else if (event.delta.type === "input_json_delta") {
          /*
           * 工具参数的片段。
           *
           * Anthropic 给的 `index` 是**整条消息里 content 块的序号**，而工具调用
           * 只占其中一部分块（前面通常还有一个 text 块）。上层要的是"这是第几个
           * 工具调用"，所以这里做一次单调映射：遇到 `tool_use` 开始块 +1，
           * 之后的 `input_json_delta` 都算在它头上。
           */
          if (activeToolIndex !== null && event.delta.partial_json) {
            yield {
              type: "tool_call_delta",
              delta: { index: activeToolIndex, argsDelta: event.delta.partial_json },
            };
          } else if (activeToolIndex === null && !warnedToolIndexGap) {
            /*
             * 收到工具参数片段却没有记下它属于哪个调用。
             * 正常流程不该发生，但真发生时**必须说出来** —— 静默丢弃的后果是
             * "模型调了工具但参数是空的"，工具层只会报"缺参数"，
             * 而真正的原因（分片没接上）永远查不到。
             */
            warnedToolIndexGap = true;
            yield {
              type: "notice",
              message:
                "收到了工具参数的片段，但没有对应的工具调用起始帧，这部分参数已被丢弃。若工具报「缺少参数」，这是原因。",
            };
          }
        } else if (event.delta.text) {
          yield { type: "text", delta: event.delta.text };
        }
        continue;
      }

      if (event.type === "content_block_start") {
        /*
         * 这里踩过一个会静默吞数据的坑：早先的实现是**平铺的 if**，
         * 而 `content_block_start` / `content_block_stop` / `message_stop`
         * 从来没有被任何分支接住，于是它们直接落到循环尾部被丢掉、也不报错。
         * 工具调用上线后，`content_block_start` 正是承载 `tool_use` 的 id 与 name
         * 的那一帧 —— 漏掉它就会得到"参数齐了但没有名字"的工具调用。
         */
        if (event.content_block?.type === "tool_use") {
          toolBlockCount += 1;
          activeToolIndex = toolIndexBase + toolBlockCount - 1;
          yield {
            type: "tool_call_delta",
            delta: {
              index: activeToolIndex,
              id: event.content_block.id,
              name: event.content_block.name,
            },
          };
        }
        continue;
      }

      if (event.type === "content_block_stop") {
        activeToolIndex = null;
        continue;
      }
    }

    if (lastUsage && lastUsage.cachedTokens === 0 && lastUsage.cacheWriteTokens === 0) {
      yield {
        type: "notice",
        message:
          "本轮没有任何缓存读取或写入。前缀短于模型的最小可缓存长度（约 1024 token）时缓存不会生效。",
      };
    }

    yield { type: "done" };
  },
};
