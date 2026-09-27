/**
 * 提供商抽象层。
 *
 * 设计约束：所有适配器都必须把 usage 归一化成 NormalizedUsage，
 * 上层（缓存仪表盘、成本核算）完全不感知底层服务商差异。
 */

export type ProviderKind = "openai" | "anthropic";

export type ChatRole = "system" | "user" | "assistant" | "tool";

/**
 * 一次工具调用（**已按分片合并完**的形态）。
 *
 * ⚠️ `argsText` 是**原始字符串**，不是解析后的对象，这一点是刻意的。
 *
 * 服务商下发的参数是跨多个分片拼接出来的 JSON 文本。回放历史时如果写成
 * `JSON.stringify(JSON.parse(argsText))`，空白、转义、键序都可能变 ——
 * 于是**服务商侧按字节比前缀的缓存永远不命中，而我们本地的分层哈希却显示"命中"**。
 * 这类不一致不会报错，只会让缓存命中率莫名其妙地低。所以从收到的那一刻起
 * 就当字符串保管，直到回放出去。
 */
export interface ToolCall {
  id: string;
  name: string;
  /** 原始 JSON 参数串（可能为空串，表示模型没给参数） */
  argsText: string;
}

/** 一次工具调用的增量分片 */
export interface ToolCallDelta {
  /** 服务商给的分片序号，用来把同一个调用的多个分片归并到一起 */
  index: number;
  /** 只在首片出现 */
  id?: string;
  /** 只在首片出现（部分网关每片都重发，合并时要幂等） */
  name?: string;
  /** 参数 JSON 的文本片段 */
  argsDelta?: string;
}

/**
 * 一条待发送的消息。
 *
 * `cacheControl` 只在 Anthropic 适配器里生效 —— 它是**层边界的载体**：
 * 组装器把 L0/L1/L2 层末尾的消息标上 ephemeral 断点，
 * 使每一层都能被独立缓存和复用。
 *
 * `toolCalls` / `toolCallId` 只在**工具轮次**里出现。没有它们时，
 * 两个适配器的序列化输出必须与此前**逐字节一致** —— 否则所有历史对话的
 * 前缀缓存会在升级那一刻全部失效（`providers.test.ts` 有断言卡着这件事）。
 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  cacheControl?: { type: "ephemeral"; ttl?: "5m" | "1h" };
  /** 供 UI 与调试用的层归属标记，不发送给服务商 */
  layer?: string;
  /** assistant 消息上：这一轮请求了哪些工具 */
  toolCalls?: ToolCall[];
  /**
   * assistant 消息上：这一轮的思维链原文。
   *
   * ⚠️ **带 `tools` 的请求必须把 `reasoning_content` 完整回传**（DeepSeek
   * 官方硬约束：不传直接 400，哪怕那一轮没调工具）。所以工具轮次的
   * assistant 消息要把思维链一起带上。不带工具时它不参与序列化。
   */
  reasoning?: string;
  /** role="tool" 的消息上：这是对哪一次调用的答复 */
  toolCallId?: string;
  /** role="tool" 的消息上：工具名（Anthropic 用它回报结果） */
  toolName?: string;
}

/**
 * 暴露给模型的工具定义。
 *
 * ⚠️ 这个数组会出现在请求体的**最前面**（Anthropic 的缓存顺序是
 * tools → system → messages，OpenAI 兼容系的 chat 模板同样把 tools 排在
 * messages 之前）。这意味着**工具集必须是近乎静态的**：
 * "按当前问题动态挑几个工具"这种看起来很聪明的优化，会让整段前缀每轮失效，
 * 把前缀缓存全吃掉。所以工具集按工作区固定，与 persona 同级，
 * 并且它的规范化序列化要参与 `requestFingerprint` 的哈希（见 `assemble.ts`）。
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema（object 根） */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 可供模型调用的工具。为空/不传时不发送 tools 字段 */
  tools?: ToolDefinition[];
  /** `"auto"` | `"none"` | `"required"` 等，按服务商能力透传 */
  toolChoice?: string;
  /** 透传给服务商的额外参数（如 top_p、thinking 开关） */
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** 归一化后的用量统计 —— 缓存仪表盘的唯一数据源 */
export interface NormalizedUsage {
  /** 本轮输入总 token（含缓存命中与写入部分） */
  promptTokens: number;
  /** 命中缓存、按折扣价计费的输入 token */
  cachedTokens: number;
  /** 显式写入缓存的 token（Anthropic 计费 1.25x）；自动缓存的服务商恒为 0 */
  cacheWriteTokens: number;
  /** 输出 token */
  completionTokens: number;
}

export type ProviderStreamEvent =
  | { type: "text"; delta: string }
  /** 思维链增量。DeepSeek-R1 / Claude thinking 会走这个通道，不计入正文 */
  | { type: "reasoning"; delta: string }
  | { type: "usage"; usage: NormalizedUsage }
  /**
   * 输出**为什么停了**。服务商在流末尾一定会给出这个信息，之前被我们丢掉了，
   * 于是"被 max_tokens 截断"和"模型正常说完了但正文为空"看起来一模一样
   * （都只是一次没有 text 的流），错误提示只能含糊地写"可能是截断"。
   *
   *  - `stop`   正常结束
   *  - `length` **被输出上限截断** —— 推理模型最常见的失败：思维链把
   *             `max_tokens` 烧完了，正文一个字都没来得及写
   *  - `tool_calls` / `tool_use`：模型要求调用工具，**不是空回复**
   *    （tools / toolChoice 见 `ChatRequest`）
   *  - 其它：按原样透传
   */
  | { type: "finish"; reason: string }
  /**
   * 工具调用的**增量分片**。
   *
   * 刻意做成增量而不是"适配器内部缓冲、最后给一个成品"：
   *  - 界面能实时显示"正在调用 search_blocks…"，而不是干等十几秒；
   *  - 两家的分片形态不同（OpenAI 是 `delta.tool_calls[].function.arguments`
   *    的字符串片段，Anthropic 是 `input_json_delta.partial_json`），
   *    把归并逻辑放在上层就只需要写一份，而不是在两个适配器里各写一遍
   *    （两遍实现迟早会分叉，而分叉的后果是"参数串拼错但看起来正常"）。
   */
  | { type: "tool_call_delta"; delta: ToolCallDelta }
  | { type: "done" }
  /** 服务商返回的非致命提示，例如缓存未生效的警告 */
  | { type: "notice"; message: string };

export interface Provider {
  readonly kind: ProviderKind;
  readonly label: string;
  /** 该服务商是否需要显式缓存断点 */
  readonly usesExplicitCacheBreakpoints: boolean;
  chat(req: ChatRequest, config: ResolvedModelConfig): AsyncGenerator<ProviderStreamEvent>;
}

/** 从 model_config 表解析出来的、可直接使用的模型连接信息 */
export interface ResolvedModelConfig {
  id: string;
  name: string;
  provider: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /**
   * 输出上限。**`null` 表示不限制** —— 请求体里不带 `max_tokens`，
   * 由服务商按它自己的上限约束。
   *
   * 为什么允许"不限制"：推理模型的思维链与正文**共用**这一个预算，
   * 而任何具体数字都会被足够长的思维链烧完（真实故障：8192 被思考耗尽、
   * 正文一个字没写）。填数字只是把故障推迟，留空才是真的解决。
   */
  maxTokens: number | null;
  contextWindow: number;
  supportsPromptCache: boolean;
  inputPrice: number;
  cachedInputPrice: number;
  outputPrice: number;
  extra: Record<string, unknown>;
}

/**
 * 提供商错误。
 *
 * 刻意**不用构造函数参数属性**（`constructor(readonly status: number)`）：
 * 那属于需要代码生成的 TS 语法，Node 的 strip-only 类型擦除（
 * `--experimental-strip-types`）会直接报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，
 * 导致测试跑不起来。显式声明字段 + 赋值可以在两种环境下都工作。
 */
export class ProviderError extends Error {
  readonly status?: number;
  readonly body?: string;

  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.body = body;
  }
}

/**
 * 把 HTTP 错误体压缩成一句可读的诊断信息。
 *
 * 除了提取服务商给的 message，还会针对几类**高频且用户难以自查**的错误
 * 追加可操作的提示。这类错误的特点是：服务商的原文是给 API 调用方看的，
 * 用户不一定能对上号，例如
 *
 *   HTTP 400: The supported API model names are deepseek-flash, deepseek-v4-pro,
 *             but you passed DeepSeek-V4.1-Flash.
 *
 * 用户多半是把自己的"配置显示名"填进了模型 ID 字段。直接在错误里点破，
 * 能省掉一轮"为什么照文档配了还报错"的排查。
 */
export function describeHttpError(status: number, body: string): string {
  const trimmed = body.trim().slice(0, 600);
  let message = `HTTP ${status}`;

  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as {
        error?: { message?: string } | string;
        message?: string;
      };
      const inner =
        typeof parsed.error === "string"
          ? parsed.error
          : (parsed.error?.message ?? parsed.message);
      if (inner) message = `HTTP ${status}: ${inner}`;
      else message = `HTTP ${status}: ${trimmed}`;
    } catch {
      // 非 JSON，直接用原文
      message = `HTTP ${status}: ${trimmed}`;
    }
  }

  return message + errorHint(status, trimmed);
}

/** 针对可识别的高频错因追加一句"该怎么改" */
function errorHint(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return "（检查 API Key 是否正确、是否已过期、以及 baseUrl 是否指向了对应服务商）";
  }
  if (status === 404) {
    return "（baseUrl 可能少写或多写了 /v1；OpenAI 兼容接口的路径通常是 <baseUrl>/chat/completions）";
  }
  if (status === 429) {
    return "（触发了服务商的频率或额度限制，稍后重试，或在模型配置里换一个模型）";
  }
  if (/supported api model names|model not found|invalid model|unknown model|does not exist/i.test(body)) {
    return "（模型 ID 填错了。这里要填服务商的**接口模型名**，不是配置显示名。请在「模型配置」里核对模型 ID 字段。）";
  }
  if (/stream_options/i.test(body)) {
    return '（该服务可能不支持 stream_options。可在模型配置的额外参数里填 {"stream_options": null} 关闭它。）';
  }
  if (/context length|too many tokens|max_tokens|context_length_exceeded/i.test(body)) {
    return "（上下文超出模型窗口。减少 @ 引用的知识块，或新建一个对话。）";
  }
  return "";
}
