/**
 * 一次对话轮次的完整编排：组装 → 发送 → 落库 → 统计。
 *
 * 这是缓存策略真正产生收益的地方，也是唯一允许把组装器输出
 * 交给服务商的地方。上层（SSE 路由）只消费事件流，不碰 prompt 组装。
 */

import { estimateTokens, MESSAGE_OVERHEAD_TOKENS } from "../tokens";
import { computeCost, type CostBreakdown, type Pricing } from "../cache/pricing";
import { assembleContext, type AssembleResult } from "../cache/assemble";
import { loadSourceBlocks, loadSourceDocs } from "../cache/source";
import type { HistoryMessage } from "../cache/assemble";
import * as repo from "../db/repo";
import type { ModelConfig } from "../db/types";
import { getProvider, resolveModelConfig } from "../providers";
import { ProviderError, type NormalizedUsage } from "../providers/types";
import type { ChatMessage, ToolCall } from "../providers/types";
import { ToolCallAccumulator, parseToolArgs } from "../providers/tool-calls";
import { TOOL_SPECS, findTool, toolDefinitions } from "./tools";

/**
 * 一次对话轮次里最多允许几轮工具调用。
 *
 * 5 是刻意选的小值：每次工具调用都是一次完整的服务商请求（要花钱、要等），
 * 而"整理知识"这件事正常只需要「读几篇 → 写一次」。
 * 上限存在的意义是**防止模型陷入自我循环**（不停地读、写、再读），
 * 那种情况下账单会一直涨而用户只看到界面在转。
 *
 * 定成常量而不是配置项：可配置的循环上限意味着用户能把账单放开到无限，
 * 而他没有办法预判模型会循环多久。
 */
const MAX_TOOL_ROUNDS = 5;

/** SSE 事件类型 */
export type ChatStreamEvent =
  | { type: "start"; conversationId: string; messageId: string; invocationId: string }
  | { type: "plan"; plan: TurnPlan }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "notice"; message: string }
  /** 模型开始调用一个工具（前端据此显示"正在调用 X…"） */
  | { type: "tool_start"; id: string; name: string; argsText: string }
  /**
   * 一个工具执行完毕。
   *
   * `summary` 是给人看的一句话，`isError` 区分"工具失败了"和"工具正常但结果为空"。
   * `targetDocId` 让前端把"已新建《X》"做成可点击的跳转 ——
   * 这样用户不看对话历史也能在库里认出哪些内容是 AI 加的。
   */
  | {
      type: "tool_result";
      id: string;
      name: string;
      /** 这个调用发生在第几轮（从 0 开始），便于排查"同一轮里重复调用" */
      round: number;
      summary: string;
      status: string;
      isError: boolean;
      targetDocId?: string | null;
    }
  | { type: "final"; result: TurnResult }
  | { type: "error"; message: string };

/** 发请求之前就能确定的全部信息，前端据此实时渲染缓存预测 */
export interface TurnPlan {
  modelName: string;
  provider: string;
  model: string;
  /** 各层构成，用于分层可视化 */
  layers: {
    name: string;
    title: string;
    hint: string;
    tokens: number;
    unchanged: boolean;
    hasBreakpoint: boolean;
  }[];
  prediction: AssembleResult["prediction"];
  invalidation: AssembleResult["invalidation"];
  /** 断点决策的说明文字 */
  breakpointNote: string;
  omittedBlockIds: string[];
  orderedBlockIds: string[];
  blockTokens: { id: string; path: string; tokens: number }[];
  totalTokens: number;
  contextWindow: number;
  sourceBudgetTokens: number;
  warnings: string[];
}

export interface TurnResult {
  messageId: string;
  invocationId: string;
  content: string;
  reasoning: string;
  usage: NormalizedUsage;
  cost: CostBreakdown;
  prediction: AssembleResult["prediction"];
  /** 预测与实际的偏差，用于验证预测模型的准确度 */
  predictionAccuracy: {
    predictedCachedTokens: number;
    actualCachedTokens: number;
    /** 实际 - 预测，正数表示我们低估了命中 */
    deltaCached: number;
  };
  latencyMs: number;
  warnings: string[];
  /**
   * 本轮执行过的工具（可能为空）。
   *
   * 带上它是为了两件事：前端能渲染"做了哪些操作"，以及用户能据此撤销
   * （`snapshotMarkdown` 就是撤销需要的全部材料）。
   */
  tools: {
    id: string;
    name: string;
    summary: string;
    status: string;
    targetDocId: string | null;
  }[];
}

export interface RunChatTurnInput {
  conversationId: string;
  content: string;
  /** 覆盖本次使用的模型；不传则用会话绑定的，再回退到默认模型 */
  modelConfigId?: string | null;
  /** 覆盖本次挂载的块集合；传了就整体替换掉会话的引用集合 */
  refBlockIds?: readonly string[];
  /**
   * 覆盖本次**整体挂载**的文档/模块；传了就整体替换。
   *
   * 这是「查漏补缺」「评判修改」的入口 —— 那类任务需要看全局，
   * 只挂几个块是判断不出"缺什么"的。
   */
  refDocIds?: readonly string[];
  signal?: AbortSignal;
}

function pricingOf(cfg: ModelConfig): Pricing {
  const resolved = resolveModelConfig(cfg);
  return {
    input: resolved.inputPrice,
    cachedInput: resolved.cachedInputPrice,
    output: resolved.outputPrice,
    cacheWrite: resolved.provider === "anthropic" ? resolved.inputPrice * 1.25 : 0,
  };
}

/** 工具执行结果 —— 审计需要的全部信息 + 回传给模型的文本 */
interface ToolExecution {
  id: string;
  name: string;
  argsText: string;
  status: string;
  summary: string;
  error: string | null;
  targetDocId: string | null;
  snapshotMarkdown: string | null;
  /** 回传给模型的内容（**必须非空**） */
  contentForModel: string;
}

/**
 * 执行一次工具调用，并**无论成败都**落一条审计。
 *
 * 三件事的顺序是刻意的：先解析参数（模型给的参数不可信）、再查工具是否存在、
 * 最后执行 —— 每一步失败都要给出一句模型能据此调整的话，
 * 而不是抛一个它看不懂的异常。
 *
 * ⚠️ 审计必须记失败。只记成功的日志会让人以为"没记录就是没执行过"，
 * 而实际上失败恰恰是最需要留痕的那种（它可能已经动了一半）。
 */
async function executeToolCall(
  call: ToolCall,
  ctx: {
    conversationId: string;
    messageId: string;
    modelConfigId: string | null;
    workspaceId: string;
    round: number;
  },
  round: number,
): Promise<ToolExecution> {
  const audit = (fields: {
    status: string;
    summary: string;
    error?: string | null;
    targetDocId?: string | null;
    snapshotMarkdown?: string | null;
  }): ToolExecution => {
    const saved = repo.recordToolCall({
      conversationId: ctx.conversationId,
      messageId: ctx.messageId,
      modelConfigId: ctx.modelConfigId,
      round,
      toolName: call.name,
      argsJson: call.argsText,
      status: fields.status,
      resultSummary: fields.summary,
      error: fields.error ?? null,
      snapshotMarkdown: fields.snapshotMarkdown ?? null,
      targetDocId: fields.targetDocId ?? null,
    });
    return {
      id: saved.id,
      name: call.name,
      argsText: call.argsText,
      status: fields.status,
      summary: fields.summary,
      error: fields.error ?? null,
      targetDocId: fields.targetDocId ?? null,
      snapshotMarkdown: fields.snapshotMarkdown ?? null,
      contentForModel: "",
    };
  };

  const parsed = parseToolArgs(call.argsText);
  if (!parsed.ok) {
    const execution = audit({ status: "arg_error", summary: "参数不是合法 JSON", error: parsed.error });
    execution.contentForModel =
      `工具 ${call.name} 的参数无法解析：${parsed.error}\n` +
      `请重新调用一次，注意参数必须是合法 JSON。`;
    return execution;
  }

  const spec = findTool(call.name);
  if (!spec) {
    const execution = audit({
      status: "unknown_tool",
      summary: `未知工具 ${call.name}`,
      error: `未知工具：${call.name}`,
    });
    execution.contentForModel =
      `没有名为 ${call.name} 的工具。可用工具：${TOOL_SPECS.map((s) => s.definition.name).join("、")}。`;
    return execution;
  }

  try {
    const result = await spec.run(parsed.args, { ...ctx, round });
    const status = result.isError ? "error" : "ok";
    const execution = audit({
      status,
      summary: result.summary,
      targetDocId: result.targetDocId ?? null,
      snapshotMarkdown: result.snapshotMarkdown ?? null,
    });
    execution.contentForModel =
      result.content.trim() === "" ? "（工具执行完毕，没有输出。）" : result.content;
    return execution;
  } catch (err) {
    /*
     * 工具自己抛了 —— 这是**代码缺陷**而不是模型的问题，所以错误信息要
     * 带上"这是内部错误"，避免模型把它当成"我参数写错了"然后反复重试。
     */
    const message = err instanceof Error ? err.message : String(err);
    const execution = audit({
      status: "exception",
      summary: `${call.name} 内部错误`,
      error: message,
    });
    execution.contentForModel =
      `工具 ${call.name} 执行时发生内部错误（不是你参数的问题）：${message}。` +
      `请不要重复调用同一个工具，直接告诉用户这件事。`;
    return execution;
  }
}

function truncateTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= 28 ? clean : `${clean.slice(0, 27)}…`;
}

/**
 * 执行一轮对话，产出事件流。
 *
 * 事件顺序保证：start → plan → (text|reasoning|notice)* → final
 * 出错时以 error 收尾，且**错误轮次也会落库**（status='error'），
 * 这样仪表盘能显示"这次失败的调用花了多少钱"。
 */
export async function* runChatTurn(input: RunChatTurnInput): AsyncGenerator<ChatStreamEvent> {
  const conversation = repo.getConversation(input.conversationId);
  if (!conversation) {
    yield { type: "error", message: "对话不存在" };
    return;
  }

  const workspace = repo.getWorkspace(conversation.workspaceId);
  if (!workspace) {
    yield { type: "error", message: "工作区不存在" };
    return;
  }

  const modelId = input.modelConfigId ?? conversation.modelConfigId;
  const cfg = modelId ? repo.getModelConfig(modelId) : repo.getDefaultModelConfig();
  if (!cfg) {
    yield { type: "error", message: "没有可用的模型配置，请先在「模型」页添加一个。" };
    return;
  }

  const resolved = resolveModelConfig(cfg);
  const provider = getProvider(resolved.provider);
  const pricing = pricingOf(cfg);

  // ---- 引用集合：本次传了就以本次为准（整体替换），否则用会话已挂载的 ----
  if (input.refBlockIds) {
    repo.setConversationRefs(conversation.id, input.refBlockIds);
  }
  const refBlockIds = repo.listRefBlockIds(conversation.id);

  if (input.refDocIds) {
    repo.setConversationDocRefs(conversation.id, input.refDocIds);
  }
  const refDocIds = repo.listRefDocIds(conversation.id);

  /*
   * 历史 = 库里已有的消息（不含本轮输入 —— 它是 L4）。
   *
   * 注意这里**先算历史、后落库本轮消息**：组装必须反映"发请求那一刻"的
   * 真实上下文，而本轮消息不属于历史。顺序反过来也能算对（按 id 排除），
   * 但先算更不容易出错。
   */
  const historyMessages = repo.listMessages(conversation.id).filter((m) => m.role !== "system");

  const history: HistoryMessage[] = historyMessages.map((m) => ({
    id: m.id,
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  const sourceBlocks = loadSourceBlocks(refBlockIds);
  const sourceDocs = loadSourceDocs(refDocIds);

  // ---- 上一轮调用：命中预测与断点决策的依据 ----
  // 必须比较**同一模型**的历史：换模型意味着服务商侧缓存完全不互通。
  const lastInvocation = repo.getLastInvocation(conversation.id);
  const sameModel = lastInvocation?.modelConfigId === cfg.id;
  const previousLayerHashes = sameModel ? lastInvocation?.layerHashes : null;
  const previousPromptTokens = sameModel
    ? (lastInvocation?.promptTokens ?? 0) + (lastInvocation?.completionTokens ?? 0)
    : null;

  const assembled = assembleContext({
    workspaceName: workspace.name,
    persona: workspace.persona,
    conventions: workspace.conventions,
    blocks: sourceBlocks,
    docs: sourceDocs,
    history,
    turn: input.content,
    sourceBudgetTokens: conversation.sourceBudgetTokens,
    contextWindow: resolved.contextWindow,
    providerKind: resolved.provider,
    previousLayerHashes,
    previousPromptTokens,
  });

  // 换模型时组装器的"未变化"判断会失真（哈希仍相同但服务商缓存不通用），
  // 因此这里覆盖失效说明，给用户一个诚实的解释。
  const invalidation = sameModel
    ? assembled.invalidation
    : lastInvocation
      ? {
          fromLayer: "L0_persona" as const,
          reason: "provider_switched" as const,
          detail: `已从「${lastInvocation.model}」切换到「${cfg.model}」，服务商缓存不互通，本轮需重新建立缓存。`,
        }
      : {
          fromLayer: "L0_persona" as const,
          reason: "cold_start" as const,
          detail: "本对话还没有调用记录，本轮需要先建立缓存。",
        };

  const prediction = sameModel
    ? assembled.prediction
    : {
        ...assembled.prediction,
        verdict: "cold" as const,
        predictedCachedTokens: 0,
        predictedWriteTokens: assembled.prediction.belowCacheFloor ? 0 : assembled.totalTokens,
        predictedMissTokens: assembled.totalTokens,
      };

  const warnings = [...assembled.warnings];
  if (prediction.belowCacheFloor) {
    warnings.push(
      `稳定前缀仅 ${prediction.stablePrefixTokens} token，短于服务商的最小可缓存长度 ${prediction.cacheFloorTokens} token —— 本轮缓存不会生效。多挂载一些知识块或延长对话后才会开始命中。`,
    );
  }
  if (cfg.supportsPromptCache === false) {
    warnings.push(`模型「${cfg.name}」在配置里标记为不支持 prompt 缓存，缓存统计可能始终为 0。`);
  }
  if (!sameModel && lastInvocation) {
    warnings.push("切换模型会让服务商侧缓存完全失效一次，频繁切换会明显抬高成本。");
  }

  const plan: TurnPlan = {
    modelName: cfg.name,
    provider: resolved.provider,
    model: resolved.model,
    layers: assembled.layers
      .filter((l) => l.tokens > 0)
      .map((l) => ({
        name: l.name,
        title: l.title,
        hint: l.tokens > 0 ? "" : "",
        tokens: l.tokens,
        unchanged: l.unchangedFromPrevious,
        hasBreakpoint: l.hasBreakpoint,
      })),
    prediction,
    invalidation,
    breakpointNote: provider.usesExplicitCacheBreakpoints
      ? describeBreakpoints(assembled, provider.label)
      : `「${provider.label}」使用自动前缀缓存，无需显式断点；只要前缀逐字节稳定即可命中。`,
    omittedBlockIds: assembled.omittedBlockIds,
    orderedBlockIds: assembled.orderedBlockIds,
    blockTokens: assembled.blockTokens,
    totalTokens: assembled.totalTokens,
    contextWindow: resolved.contextWindow,
    sourceBudgetTokens: conversation.sourceBudgetTokens,
    warnings,
  };

  const startedAt = Date.now();

  /*
   * 顺序是刻意的：**先算完缓存计划推给前端，再落库、再校验凭据、最后发请求**。
   *
   * 早期版本在开头就检查 API Key，缺 Key 时直接返回一条 error 就结束了 ——
   * 结果是用户敲完一段话点发送，既看不到本轮的分层构成与命中预测，
   * 那段话也没有被保存下来，等于白打一遍。而"看不到缓存会怎样"恰恰是这个
   * 软件最该让人看到的东西。现在缺 Key 也会先给出完整的 plan。
   */
  yield {
    type: "start",
    conversationId: conversation.id,
    messageId: "", // 消息还没落库，落在下面；前端此时只需要一个"开始"信号
    invocationId: "",
  };
  yield { type: "plan", plan };

  // ---- 到这里才落库本轮输入：即便随后调用失败，用户的话也不会丢 ----
  const userMessage = repo.appendMessage({
    conversationId: conversation.id,
    role: "user",
    content: input.content,
    refBlockIds,
  });

  // 首条消息顺手把会话标题从"新对话"改成用户第一句话
  if (conversation.title === "新对话") {
    repo.updateConversation(conversation.id, { title: truncateTitle(input.content) });
  }

  // ---- 凭据校验放在 plan 之后 ----
  if (!cfg.apiKey.trim()) {
    yield {
      type: "error",
      message: `模型「${cfg.name}」还没有填写 API Key。请点左侧栏顶部的齿轮进入「模型配置」补齐，然后重新发送这一条。`,
    };
    return;
  }

  // ---- 发起请求 ----
  let text = "";
  let reasoning = "";

  /*
   * 对话消息的**可变副本**。
   *
   * 工具轮次需要往里追加 assistant(tool_calls) 与 tool 结果，所以不能直接用
   * `assembled.messages`（那是组装器的产物，代表"发请求那一刻"的上下文）。
   *
   * ⚠️ 刻意**不重新跑 assembleContext**：重跑会把在途的工具消息丢掉，
   * 而且算出来的 prefixHash 与实际发出去的内容对不上，缓存预测跟着失真。
   * 工具轮的正确模型是"在已组装好的前缀后面追加"，不是"重新组装一次"。
   */
  const conversationMessages: ChatMessage[] = [...assembled.messages];
  const messageId = userMessage.id;
  const usage: NormalizedUsage = {
    promptTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    completionTokens: 0,
  };
  let sawUsage = false;
  let failure: string | null = null;
  /**
   * 服务商给出的停止原因（`stop` / `length` / `max_tokens` / `end_turn`…）。
   *
   * 这是区分"推理模型把预算烧完了"和"服务商返回了空响应"的**唯一**依据。
   * 在被传上来之前，两种情况都只表现为"一次没有 text 的正常流"，
   * 于是错误提示只能含糊地写"可能是截断"，用户不知道该调什么。
   */
  /**
   * 一次工具执行的轨迹（审计 + 前端展示 + 撤销都用它）。
   *
   * `snapshotMarkdown` 只对写入类工具存在，是"一键撤销"唯一需要的东西。
   */
  interface ToolRunRecord {
    id: string;
    name: string;
    argsText: string;
    status: string;
    summary: string;
    error: string | null;
    targetDocId: string | null;
    snapshotMarkdown: string | null;
  }

  let finishReason = "";
  /** 这一次请求最终是否以"要调工具"结束（决定要不要执行、要不要继续下一轮） */
  let wantsTools = false;
  /** 整轮里执行过的所有工具（可能跨多轮） */
  const toolRuns: ToolRunRecord[] = [];
  /** 请求了工具但模型没给完整调用信息 */
  let droppedTools = 0;
  /** 收到了工具分片但结束原因不是 tool_calls（参数残缺，绝不能执行） */
  let incompleteToolRound = false;

  const toolCtx = {
    conversationId: conversation.id,
    messageId,
    modelConfigId: resolved.id,
    workspaceId: conversation.workspaceId,
    round: 0,
  };

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      /*
       * 每轮用**新的**累积器。跨轮复用一个会让上一轮的分片混进这一轮，
       * 拼出来的参数既不是 A 也不是 B（而且看起来像合法 JSON）。
       */
      const toolAcc = new ToolCallAccumulator();
      let roundText = "";
      let roundReasoning = "";
      let roundFinish = "";

      for await (const event of provider.chat(
        { messages: conversationMessages, tools: toolDefinitions(), signal: input.signal },
        resolved,
      )) {
        switch (event.type) {
          case "text":
            text += event.delta;
            roundText += event.delta;
            yield { type: "text", delta: event.delta };
            break;
          case "reasoning":
            reasoning += event.delta;
            roundReasoning += event.delta;
            yield { type: "reasoning", delta: event.delta };
            break;
          case "usage":
            sawUsage = true;
            usage.promptTokens = event.usage.promptTokens;
            usage.cachedTokens = event.usage.cachedTokens;
            usage.cacheWriteTokens = event.usage.cacheWriteTokens;
            usage.completionTokens = event.usage.completionTokens;
            break;
          case "tool_call_delta":
            /*
             * ⚠️ 这个 case 不能省。
             *
             * 这个 switch **没有 default**，TypeScript 也不会因为漏了某个变体
             * 而报错（联合类型在 switch 里不强制穷尽）。所以新加一种 provider
             * 事件却忘了这里的话，事件会被**静默丢弃** —— 表现是"模型明明调了
             * 工具，但什么都没有发生"，没有任何日志、没有报错。
             */
            toolAcc.push(event.delta);
            break;
          case "finish":
            finishReason = event.reason;
            roundFinish = event.reason;
            break;
          case "notice":
            warnings.push(event.message);
            yield { type: "notice", message: event.message };
            break;
          case "done":
            break;
        }
      }

      wantsTools = roundFinish === "tool_calls" || roundFinish === "tool_use";
      if (!wantsTools) {
        // 收到了分片却没以 tool_calls 结束 → 参数残缺，标记出来并且不执行
        if (toolAcc.size > 0) incompleteToolRound = true;
        break;
      }

      const { calls, dropped } = toolAcc.finish();
      droppedTools += dropped;
      if (calls.length === 0) {
        // 声称要调工具却一个完整调用都没收到 —— 终止，归因交给下面
        break;
      }
      // 没有工具可用时不该出现 tool_calls；真出现了就明确报错而不是空转
      if (TOOL_SPECS.length === 0) {
        warnings.push("模型请求调用工具，但当前没有注册任何工具。");
        break;
      }

      /*
       * 把 assistant 这一轮的话原样记进对话，再接上工具结果。
       *
       * ⚠️ `reasoning` 必须带上：DeepSeek 明确要求"带 tools 的请求，后续每一次
       * 都要把 reasoning_content 完整回传，哪怕那一轮没调工具，否则 400"。
       * 丢掉它既是接口报错，也会让前缀逐字节不等 —— 缓存永远不命中。
       */
      conversationMessages.push({
        role: "assistant",
        content: roundText,
        reasoning: roundReasoning,
        toolCalls: calls,
      });

      let aborted = false;
      for (const call of calls) {
        /*
         * 每个工具执行**前**都要查一次中止信号。
         *
         * fetch 的 signal 管不到本地工具执行：用户点了停止之后，网络请求会断，
         * 但接下来那句"往文档里写 8 个块"照样会跑完 —— 那是最坏的一种形态，
         * 用户以为停住了，实际笔记被改了。
         */
        if (input.signal?.aborted) {
          aborted = true;
          warnings.push(
            `已停止：还有 ${calls.length - toolRuns.length} 个工具没有执行。已经执行的改动保留在库里，可以在工具记录里撤销。`,
          );
          break;
        }

        yield {
          type: "tool_start",
          id: call.id,
          name: call.name,
          argsText: call.argsText,
        };

        const record = await executeToolCall(call, toolCtx, round);
        toolRuns.push(record);
        conversationMessages.push({
          role: "tool",
          content: record.contentForModel,
          toolCallId: call.id,
          toolName: call.name,
        });

        yield {
          type: "tool_result",
          id: record.id,
          name: record.name,
          round,
          summary: record.summary,
          status: record.status,
          isError: record.status !== "ok",
          targetDocId: record.targetDocId,
        };
      }

      if (aborted) break;

      /*
       * 最后一轮还没结束就说明撞上了上限。必须说出来 ——
       * 静默停下会让用户看到一段没有结论的回答，而他不知道是被截断了。
       */
      if (round === MAX_TOOL_ROUNDS - 1) {
        warnings.push(
          `工具调用达到上限（${MAX_TOOL_ROUNDS} 轮），已停止继续调用。可以把问题拆小一点再问。`,
        );
      }
    }
  } catch (err) {
    failure = err instanceof ProviderError ? err.message : String(err);
  }

  const latencyMs = Date.now() - startedAt;

  // 服务商没返回 usage 时用估算兜底，并在结果里明确标注这是估算值
  if (!sawUsage) {
    const estimatedPrompt =
      assembled.messages.reduce(
        (sum, m) => sum + estimateTokens(m.content) + MESSAGE_OVERHEAD_TOKENS,
        0,
      ) + (text ? 0 : 0);
    usage.promptTokens = estimatedPrompt;
    // 基于前缀稳定性做保守推测：命中部分不超过上一轮实际写入量
    usage.cachedTokens = Math.min(
      prediction.stablePrefixTokens,
      lastInvocation?.promptTokens ?? 0,
    );
    usage.completionTokens = estimateTokens(text);
    if (!failure) {
      warnings.push(
        "服务商未返回 usage，以上 token 与费用为本地估算值，仅供参考（不影响对话内容）。",
      );
    }
  }

  // ---- 若无有效输出且有错误，就是一次失败调用 ----

  /*
   * 空回复的四种情形，**分开报**。
   *
   * 用户实际遇到的是第一种：点「AI 分析」后看着思维链一直输出，然后戛然而止，
   * 正文一个字都没有。旧代码对这种情形只说"可能是输出被 max_tokens 截断"，
   * 既不确定（"可能"）、也不可行动（该调哪个值？调到多少？）。
   *
   * 现在 finish_reason 是权威依据，可以给出确定的结论和具体的下一步。
   *
   * ⚠️ 这段必须在下面算 `status` **之前**跑完。
   * 早先的写法是先 `const status = failure ? "error" : "ok"` 再判空回复，
   * 于是空回复被记成 `ok` —— 后果有三，每一个都是真故障：
   *   1. 它会被 `getLastInvocation` 当成**下一轮的缓存基准**，
   *      而这一轮根本没有内容写进服务商缓存，预测随之失真；
   *   2. 空的助手消息不落库，用户回头看不到"当时没出结果"；
   *   3. 统计里凭空多一次成功调用。
   */
  if (!failure && !text.trim()) {
    // 判断是否被输出上限截断：OpenAI 兼容是 `length`，Anthropic 是 `max_tokens`
    const truncated = finishReason === "length" || finishReason === "max_tokens";
    const budget = resolved.maxTokens;
    const spent = usage.completionTokens;
    /*
     * 上限可能是 null（用户在配置里留空 = 不限制）。
     *
     * ⚠️ 这种情形下**不能**再劝用户"把最大输出调大" —— 他已经在"不限制"上了，
     * 那条建议会让他去改一个空字段，改完什么都不变，于是故障看起来无解。
     * 此时唯一还能调的是"少想一点"：截断来自服务商自己的上限，
     * 而思维链和正文抢的就是那个上限。
     */
    const limitText = typeof budget === "number" ? `上限 ${budget} token` : "输出上限";

    /*
     * ⚠️ 工具调用必须**先于**其它分支判断。
     *
     * 模型要求调用工具时，`content` 是空的、`finish_reason` 是 `tool_calls`
     * （Anthropic 是 `tool_use`）—— 这正是"空回复"的形状。不单独成支的话，
     * 第一次工具调用就会掉进最后那个 `else`，被判成
     * "服务商返回了空响应"、记一条 `status='error'` 的假故障，
     * 而实际上一切正常。这种假故障比真故障更难查：它每天都在报警，
     * 于是真正的故障也被一起忽略。
     */
    /*
     * 工具调用的事在前面的多轮循环里已经处理完了：执行过的记在 `toolRuns` 里，
     * 这里只负责"要不要判成失败"。判据用循环留下的三个标记，不再碰累积器
     * （它现在是每轮一个的局部变量）。
     */
    if (wantsTools) {
      if (toolRuns.length > 0 || droppedTools > 0) {
        /*
         * 有工具执行过 —— 这不是失败。
         * 只把"丢弃了几个"说出来：静默丢弃会让
         * "模型调了工具但没执行"变成一桩无头案。
         */
        if (droppedTools > 0) {
          warnings.push(
            `模型请求了 ${droppedTools} 次工具调用，但缺少调用 id 或工具名，已跳过。`,
          );
        }
      } else {
        /*
         * 声称要调工具，却一个完整调用都没收到（或者收到了却撞上轮次上限
         * 之前就断了）。这确实是异常，但要给出**与"空响应"不同的**原因 ——
         * 它通常是流被中断，而不是模型没说话。
         */
        failure =
          "模型表示要调用工具，但没有收到完整的工具调用信息（可能流被中断）。" +
          "重试一次通常就好；若反复出现，检查是否有代理截断了响应流。";
      }
    } else if (incompleteToolRound && !truncated) {
      /*
       * 收到了工具调用分片，但结束原因**不是** tool_calls —— 说明这一轮
       * 是被别的原因打断的（`length` / `aborted` / `insufficient_system_resource`）。
       * 此时参数多半是半截的，**绝不能拿去执行**：那会真的去改用户的笔记。
       * 归因交给下面的 truncated 分支，这里只补一句说明。
       */
      warnings.push(
        "这一轮收到了工具调用的片段，但输出没能正常结束，参数可能不完整，因此没有执行任何工具。",
      );
    } else if (truncated && reasoning.trim()) {
      /*
       * 最典型、也最容易被误判成"服务商坏了"的情形：
       * 推理模型把整个输出预算花在思维链上，正文还没开始写就被截断。
       * 必须说清"思维链算在同一个预算里" —— 这是用户唯一需要知道的知识点。
       */
      failure =
        `模型的思考过程用完了全部${limitText}${spent > 0 ? `（实际输出 ${spent}）` : ""}` +
        `，正文还没开始写就被截断了。\n` +
        `这轮已经产生的思考内容仍有参考价值，可以在上面展开查看。\n` +
        (budget === null
          ? `这个模型已经设为「不限制输出」，所以截断来自服务商自己的上限。` +
            `让它少想一点通常能解决（例如把额外参数里的 thinking 关掉，或降低 reasoning_effort）。`
          : `解决办法：到「模型配置」里把这个模型的「最大输出」调到 65536 以上，` +
            `或者干脆**留空**（= 不限制，用服务商的原生默认值）——` +
            `只要还填着具体数字，思维链够长就还能把它烧完。`);
    } else if (truncated) {
      failure =
        `输出被${limitText}截断了，没有产生任何可见内容。` +
        (budget === null
          ? `这个模型已经设为「不限制输出」，请改成让它少想一点（例如把额外参数里的 thinking 关掉）。`
          : `请到「模型配置」里调大这个模型的「最大输出」，或直接留空表示不限制。`);
    } else if (reasoning.trim()) {
      failure =
        "模型只返回了思考过程，没有返回正文内容。" +
        "换一种问法或让它在回答里直接给出结论通常能解决；" +
        "如果反复出现，说明这个模型对当前指令的适配有问题，可以到「模型配置」检查模型名是否填对。";
    } else {
      failure =
        `服务商返回了空响应（停止原因：${finishReason || "未提供"}）。` +
        "常见原因是模型名写错、额外参数不被支持，或这一轮被服务商的审核拦下。";
    }
  }

  /*
   * ---- 判定这一轮的成败 ----
   *
   * 必须在空回复归因**之后**算：`failure` 可能刚刚才被那段代码填上。
   * 另外"有正文"这一点独立成立就足以算成功 —— 模型正常回答完，
   * 我们不该因为别的告警把它降级成失败。
   */
  const status = failure ? "error" : "ok";

  const assistantMessage =
    text.trim() || status === "error"
      ? repo.appendMessage({
          conversationId: conversation.id,
          role: "assistant",
          content: text,
        })
      : null;

  const cost = computeCost(usage, pricing);
  const layerHashes: Record<string, string> = {};
  for (const l of assembled.layers) layerHashes[l.name] = l.hash;

  const invocation = repo.recordInvocation({
    conversationId: conversation.id,
    messageId: assistantMessage?.id ?? null,
    modelConfigId: cfg.id,
    provider: resolved.provider,
    model: resolved.model,
    layerHashes,
    prefixHash: assembled.prefixHash,
    stablePrefixTokens: assembled.stablePrefixTokens,
    predictedCachedTokens: prediction.predictedCachedTokens,
    predictedWriteTokens: prediction.predictedWriteTokens,
    promptTokens: usage.promptTokens,
    cachedTokens: usage.cachedTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    completionTokens: usage.completionTokens,
    actualUsd: cost.actualUsd,
    baselineUsd: cost.baselineUsd,
    savedUsd: cost.savedUsd,
    latencyMs,
    status,
    error: failure,
    requestFingerprint: `${resolved.provider}:${resolved.model}:${assembled.prefixHash.slice(0, 16)}`,
  });

  if (failure) {
    yield { type: "error", message: failure };
    return;
  }

  yield {
    type: "final",
    result: {
      messageId: assistantMessage?.id ?? "",
      invocationId: invocation.id,
      content: text,
      reasoning,
      usage,
      cost,
      prediction,
      predictionAccuracy: {
        predictedCachedTokens: prediction.predictedCachedTokens,
        actualCachedTokens: usage.cachedTokens,
        deltaCached: usage.cachedTokens - prediction.predictedCachedTokens,
      },
      latencyMs,
      warnings,
      tools: toolRuns.map((run) => ({
        id: run.id,
        name: run.name,
        summary: run.summary,
        status: run.status,
        targetDocId: run.targetDocId,
      })),
    },
  };
}

function describeBreakpoints(assembled: AssembleResult, providerLabel: string): string {
  const withBp = assembled.layers.filter((l) => l.hasBreakpoint);
  if (withBp.length === 0) {
    return `「${providerLabel}」需要显式缓存断点，但本轮没有稳定的前缀可用于打断点，因此跳过（避免写入溢价白白浪费）。`;
  }
  const names = withBp.map((l) => l.title).join("、");
  return `「${providerLabel}」在 ${names} 处打缓存断点，覆盖前 ${assembled.stablePrefixTokens} token 的稳定前缀。`;
}

/**
 * 只做组装与预测，不发起请求。
 *
 * 供「缓存预览」面板使用：用户改 @ 引用或换模型时，
 * 可以立刻看到"这一改会损失多少缓存"，而不必真的花一次钱去试。
 */
export function previewTurn(input: {
  conversationId: string;
  content: string;
  modelConfigId?: string | null;
  refBlockIds?: readonly string[];
  refDocIds?: readonly string[];
}): { plan: TurnPlan } | { error: string } {
  const conversation = repo.getConversation(input.conversationId);
  if (!conversation) return { error: "对话不存在" };
  const workspace = repo.getWorkspace(conversation.workspaceId);
  if (!workspace) return { error: "工作区不存在" };

  const modelId = input.modelConfigId ?? conversation.modelConfigId;
  const cfg = modelId ? repo.getModelConfig(modelId) : repo.getDefaultModelConfig();
  if (!cfg) return { error: "没有可用的模型配置" };

  const resolved = resolveModelConfig(cfg);
  const provider = getProvider(resolved.provider);

  const refBlockIds = input.refBlockIds ?? repo.listRefBlockIds(conversation.id);
  const refDocIds = input.refDocIds ?? repo.listRefDocIds(conversation.id);
  const history = repo
    .listMessages(conversation.id)
    .filter((m) => m.role !== "system")
    .map((m) => ({
      id: m.id,
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: m.content,
    }));

  const lastInvocation = repo.getLastInvocation(conversation.id);
  const sameModel = lastInvocation?.modelConfigId === cfg.id;

  const assembled = assembleContext({
    workspaceName: workspace.name,
    persona: workspace.persona,
    conventions: workspace.conventions,
    blocks: loadSourceBlocks(refBlockIds),
    docs: loadSourceDocs(refDocIds),
    history,
    turn: input.content,
    sourceBudgetTokens: conversation.sourceBudgetTokens,
    contextWindow: resolved.contextWindow,
    providerKind: resolved.provider,
    previousLayerHashes: sameModel ? lastInvocation?.layerHashes : null,
    previousPromptTokens: sameModel
      ? (lastInvocation?.promptTokens ?? 0) + (lastInvocation?.completionTokens ?? 0)
      : null,
  });

  const invalidation = sameModel
    ? assembled.invalidation
    : lastInvocation
      ? {
          fromLayer: "L0_persona" as const,
          reason: "provider_switched" as const,
          detail: `切换到「${cfg.model}」后服务商缓存不互通，本轮需重新建立缓存。`,
        }
      : {
          // 从来没有过调用记录 —— 这是冷启动，不是"切换了模型"。
          // 两种情况虽然命中都为 0，但对用户的意义完全不同：
          // 冷启动是预期内的，而"切换模型"是要提醒他别频繁切。
          fromLayer: "L0_persona" as const,
          reason: "cold_start" as const,
          detail: "本对话还没有该模型的调用历史，本轮需要先建立缓存。",
        };

  return {
    plan: {
      modelName: cfg.name,
      provider: resolved.provider,
      model: resolved.model,
      layers: assembled.layers
        .filter((l) => l.tokens > 0)
        .map((l) => ({
          name: l.name,
          title: l.title,
          hint: "",
          tokens: l.tokens,
          unchanged: l.unchangedFromPrevious,
          hasBreakpoint: l.hasBreakpoint,
        })),
      prediction: sameModel
        ? assembled.prediction
        : {
            ...assembled.prediction,
            verdict: "cold",
            predictedCachedTokens: 0,
            predictedWriteTokens: assembled.prediction.belowCacheFloor
              ? 0
              : assembled.totalTokens,
            predictedMissTokens: assembled.totalTokens,
          },
      invalidation,
      breakpointNote: provider.usesExplicitCacheBreakpoints
        ? describeBreakpoints(assembled, provider.label)
        : `「${provider.label}」使用自动前缀缓存，无需显式断点。`,
      omittedBlockIds: assembled.omittedBlockIds,
      orderedBlockIds: assembled.orderedBlockIds,
      blockTokens: assembled.blockTokens,
      totalTokens: assembled.totalTokens,
      contextWindow: resolved.contextWindow,
      sourceBudgetTokens: conversation.sourceBudgetTokens,
      warnings: assembled.warnings,
    },
  };
}
