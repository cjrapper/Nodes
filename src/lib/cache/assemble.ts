/**
 * 上下文组装器 —— 缓存优化的核心。
 *
 * 输入是"这一轮要用哪些知识块、历史说了什么"，输出是一组**已分层、
 * 已定序、已标注断点**的消息，以及可供仪表盘使用的命中预测。
 *
 * 不变式（改动本文件时必须保持）：
 *   I1. 层顺序永远等于 LAYER_ORDER，任何层都不会被提前。
 *   I2. 不存在任何非确定性来源（时间、随机、Map 原序、locale 相关排序）。
 *   I3. 同角色相邻消息的合并只发生在 L0/L1（各自独立保留为 Anthropic
 *       system 块），历史与知识块绝不跨层合并。
 *   I4. 历史只追加，绝不改写或删除中间消息。
 */

import { createHash } from "node:crypto";

import { cacheBlockSizeFor, estimateTokens, MESSAGE_OVERHEAD_TOKENS } from "../tokens";
import type { ChatMessage } from "../providers/types";
import {
  LAYER_META,
  LAYER_ORDER,
  renderDocContent,
  renderDocIndex,
  renderPersona,
  renderSourceContent,
  renderSourceIndex,
  renderWorkspace,
  selectBlocksWithinBudget,
  sortBlocksDeterministically,
  sortDocsDeterministically,
  type LayerName,
  type SourceBlock,
  type SourceDoc,
} from "./layers";

/** 历史消息（已从库里按 seq 升序读出） */
export interface HistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 该消息是否承载了知识块引用（用于渲染可读的来源标记） */
  refLabels?: string[];
}

export interface AssembleInput {
  workspaceName: string;
  persona: string;
  conventions: string;
  /** 本次要挂载的知识块（顺序任意，组装器会稳定重排） */
  blocks: readonly SourceBlock[];
  /**
   * 本次要**整体挂载**的文档/模块（顺序任意）。
   *
   * 与块级引用的区别是粒度：块级适合"就这几段回答我"，
   * 整篇挂载适合"看看这个方向我整理得怎么样" —— 后者正是
   * 「查漏补缺」「评判修改」这类学习任务需要的能力。
   */
  docs?: readonly SourceDoc[];
  /** 历史消息，seq 升序 */
  history: readonly HistoryMessage[];
  /** 本轮用户输入 */
  turn: string;
  /** 知识块正文的 token 预算 */
  sourceBudgetTokens: number;
  /** 模块正文的 token 预算（不传则复用 sourceBudgetTokens） */
  docBudgetTokens?: number;
  /** 模型上下文窗口，用于整体超限告警 */
  contextWindow: number;
  /** 服务商类型，决定缓存对齐粒度 */
  providerKind: string;
  /** 上一轮 invocation 的分层哈希，用于命中预测与断点决策 */
  previousLayerHashes?: Readonly<Record<string, string>> | null;
  /** 上一轮实际计入的输入 token 总量（真实 usage 优先，否则用预测值） */
  previousPromptTokens?: number | null;
  /**
   * 服务商的最小可缓存长度，默认 1024。
   *
   * 前缀短于它时缓存机制根本不会生效 —— 这与"算了但命中 0"必须区分开：
   * 前者是"这项能力本轮没用上"，后者是"用上了但没命中"。
   */
  cacheFloorTokens?: number;
}

/** 一层组装后的结果 */
export interface AssembledLayer {
  name: LayerName;
  title: string;
  /** 该层渲染出的文本；空串表示该层本轮不存在 */
  text: string;
  tokens: number;
  /** 层内容哈希（不含前序层，便于定位"是哪一层变了"） */
  hash: string;
  /** 累进到本层为止的哈希，可用作缓存指纹 */
  prefixHash: string;
  /** 与上一轮相比本层是否逐字节相同 */
  unchangedFromPrevious: boolean;
  /** 本轮是否为该层打了缓存断点 */
  hasBreakpoint: boolean;
}

export type CacheVerdict =
  | "hit" // 与上一轮完全相同，预期全部命中
  | "partial" // 前缀命中，本层开始是新内容
  | "cold" // 无历史，首次建立缓存（需付写入成本）
  | "empty";

export interface CachePrediction {
  verdict: CacheVerdict;
  /** 预期按折扣价读取的 token 数 */
  predictedCachedTokens: number;
  /** 预期新写入缓存的 token 数 */
  predictedWriteTokens: number;
  /** 预期按全价计费的 token 数 */
  predictedMissTokens: number;
  /** 稳定前缀的 token 总量（不管是否命中缓存都存在的前缀） */
  stablePrefixTokens: number;
  /** 本轮输入总 token（预测值） */
  totalInputTokens: number;
  /**
   * 稳定前缀是否短于服务商的最小可缓存长度。
   * 为 true 时缓存机制**完全不生效** —— 与"命中 0 个 token"是两回事，
   * 仪表盘需要区分展示，否则用户会误以为优化没做对。
   */
  belowCacheFloor: boolean;
  /** 服务商的最小可缓存长度（token） */
  cacheFloorTokens: number;
}

/** 缓存失效的根因 */
export interface InvalidationCause {
  /** 从哪一层开始失效 */
  fromLayer: LayerName;
  /** 机器可读的失效类型 */
  reason:
    | "cold_start"
    | "persona_changed"
    | "conventions_changed"
    | "refs_changed"
    | "block_edited"
    | "history_rewritten"
    | "provider_switched"
    | "none";
  /** 面向用户的中文解释 */
  detail: string;
}

export interface AssembleResult {
  messages: ChatMessage[];
  layers: AssembledLayer[];
  /** 整段上下文的指纹 */
  prefixHash: string;
  /** 稳定前缀（L0..最后命中层）的 token 数 */
  stablePrefixTokens: number;
  prediction: CachePrediction;
  invalidation: InvalidationCause;
  /** 被 @ 但正文因预算未展开的块 id */
  omittedBlockIds: string[];
  /** 参与排序后的知识块，供 UI 展示顺序 */
  orderedBlockIds: string[];
  /** 逐块的 token 占用，供仪表盘明细 */
  blockTokens: { id: string; path: string; tokens: number }[];
  totalTokens: number;
  warnings: string[];
}

const LAYER_SEPARATOR = "\u0000";

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 链式哈希：把前序层的指纹与本层内容混合 */
export function chainHash(prev: string, layerName: string, text: string): string {
  return sha256(`${prev}${LAYER_SEPARATOR}${layerName}${LAYER_SEPARATOR}${text}`);
}

/**
 * 判断哪些层值得打 Anthropic 缓存断点。
 *
 * Anthropic 写入缓存要付 1.25x、读取只要 0.1x。因此**给一个每轮都会变的层
 * 打断点是负收益**（每轮多付 25% 却永远读不到）。
 *
 * 策略：
 *  - 只有哈希与上一轮相同的层才考虑打断点（已被证明是稳定的）。
 *  - 取满足条件的最深一层作为唯一断点 —— 它天然覆盖了之前的所有层。
 *  - 首次对话没有任何"已证明稳定"的层，只在 L0 打断点建立起点缓存。
 *  - 前缀短于 minimumTokens 时放弃断点，因为大多数模型的最小可缓存
 *    长度在 1024 token 左右，低于此值缓存不会生效。
 */
export function decideBreakpoints(
  layers: readonly AssembledLayer[],
  previousLayerHashes: Readonly<Record<string, string>> | null | undefined,
  minimumTokens: number,
): { breakpointLayer: LayerName | null; reason: string } {
  const meaningful = layers.filter((l) => l.tokens > 0);
  if (meaningful.length === 0) {
    return { breakpointLayer: null, reason: "上下文为空，无需缓存" };
  }

  const hasPrevious = !!previousLayerHashes && Object.keys(previousLayerHashes).length > 0;

  if (!hasPrevious) {
    /*
     * 冷启动：在最早稳定层建立缓存起点。
     *
     * ⚠️ 这里**也必须过一遍门槛**。
     *
     * 早先这个分支直接 return，门槛检查写在下面的"有上一轮"分支里，
     * 只有那条路径能走到。后果是一组自相矛盾的状态同时出现在界面上：
     *
     *   - 请求里带上了 `cache_control`，而前缀只有 164 token ——
     *     Anthropic 根本不会缓存它，那 1.25x 的写入溢价是纯浪费；
     *   - `prediction.belowCacheFloor` 同时为 true，界面显示"本轮缓存不会生效"；
     *     于是一边写着"缓存不生效"、一边写着"已在 L0 打了断点"；
     *   - 断点说明里还会打印"覆盖前 0 token 的稳定前缀" ——
     *     因为冷启动时 stablePrefixTokens 本来就是 0。
     *
     * 更糟的是下一轮同样的上下文又变成不打断点了（那时走的是有门槛的分支），
     * 于是相同的前缀在两轮之间反复横跳，用户看到的是随机行为。
     *
     * 门槛的判据只有一份：稳定前缀长度。它与"有没有上一轮"无关。
     */
    const first = meaningful.find((l) => LAYER_META[l.name].breakpointCandidate);
    if (!first) return { breakpointLayer: null, reason: "没有可作为断点的层" };

    const firstCumulative = meaningful
      .slice(0, meaningful.indexOf(first) + 1)
      .reduce((sum, l) => sum + l.tokens, 0);

    if (firstCumulative < minimumTokens) {
      return {
        breakpointLayer: null,
        reason: `稳定前缀仅 ${firstCumulative} token，低于最小可缓存长度 ${minimumTokens}，断点无意义（写入溢价换不来缓存命中）`,
      };
    }

    return {
      breakpointLayer: first.name,
      reason: "首次对话：在最早稳定层建立缓存起点（需付一次写入成本）",
    };
  }

  // 从深到浅找最深的、与上一轮逐字节相同的断点候选层
  const candidates = meaningful
    .filter((l) => LAYER_META[l.name].breakpointCandidate && l.unchangedFromPrevious)
    .reverse();

  const chosen = candidates[0];
  if (!chosen) {
    return {
      breakpointLayer: null,
      reason: "所有层相对上一轮都发生了变化，本轮无可复用前缀，跳过断点以避免写入损失",
    };
  }

  // 累积到该层为止的 token 量
  const cumulative = meaningful
    .slice(0, meaningful.indexOf(chosen) + 1)
    .reduce((sum, l) => sum + l.tokens, 0);

  if (cumulative < minimumTokens) {
    return {
      breakpointLayer: null,
      reason: `稳定前缀仅 ${cumulative} token，低于最小可缓存长度 ${minimumTokens}，断点无意义`,
    };
  }

  return {
    breakpointLayer: chosen.name,
    reason: `在 ${LAYER_META[chosen.name].title} 打下断点，覆盖前 ${cumulative} token 的稳定前缀`,
  };
}

/**
 * 主组装函数。纯函数：不读数据库、不看时钟、不碰全局状态。
 */
export function assembleContext(input: AssembleInput): AssembleResult {
  const warnings: string[] = [];
  const blockSize = cacheBlockSizeFor(input.providerKind);

  // ---- L2 预计算：稳定排序 + 预算裁剪 ----
  const ordered = sortBlocksDeterministically(input.blocks);
  const { omittedIds } = selectBlocksWithinBudget(ordered, input.sourceBudgetTokens);

  const docBudget = input.docBudgetTokens ?? input.sourceBudgetTokens;
  const orderedDocs = sortDocsDeterministically(input.docs ?? []);
  const renderedDocIndex = renderDocIndex(orderedDocs);
  const renderedDocContent = renderDocContent(orderedDocs, docBudget);

  // ---- 逐层渲染 ----
  const rendered: Record<LayerName, string> = {
    L0_persona: renderPersona(input.persona, input.workspaceName),
    L1_workspace: renderWorkspace(input.conventions),
    L2_source_index: renderSourceIndex(ordered),
    L2_source_content: renderSourceContent(ordered, omittedIds),
    L2_doc_index: renderedDocIndex,
    L2_doc_content: renderedDocContent,
    L3_history: "", // 历史按消息逐条渲染，见下方
    L4_turn: input.turn.trim(),
  };

  const breakpointDecision = { layer: null as LayerName | null, reason: "" };

  // ---- 构造分层结果 ----
  const layers: AssembledLayer[] = [];
  let prefixHash = sha256("nodes/context/v1");

  const pushLayer = (name: LayerName, text: string, tokens: number) => {
    const hash = chainHash(prefixHash, name, text);
    const previous = input.previousLayerHashes?.[name];
    layers.push({
      name,
      title: LAYER_META[name].title,
      text,
      tokens,
      hash,
      prefixHash: hash,
      unchangedFromPrevious: previous !== undefined && previous === hash,
      hasBreakpoint: false,
    });
    prefixHash = hash;
  };

  // L0 / L1
  pushLayer("L0_persona", rendered.L0_persona, estimateTokens(rendered.L0_persona));
  pushLayer("L1_workspace", rendered.L1_workspace, estimateTokens(rendered.L1_workspace));

  // L2 清单与正文
  pushLayer("L2_source_index", rendered.L2_source_index, estimateTokens(rendered.L2_source_index));
  pushLayer(
    "L2_source_content",
    rendered.L2_source_content,
    estimateTokens(rendered.L2_source_content),
  );

  /*
   * 模块层紧跟在块层之后。
   *
   * 顺序上把"块"放在"整篇文档"之前，有两个理由：
   *  1. 块级引用更常用、也更稳定（用户很少动），放前面能让最常见的前缀
   *     尽量长；
   *  2. 整篇挂载的内容量大且变动更频繁，放后面意味着它变化时
   *     不会连累前面已经命中的部分。
   */
  pushLayer("L2_doc_index", rendered.L2_doc_index, estimateTokens(rendered.L2_doc_index));
  pushLayer("L2_doc_content", rendered.L2_doc_content, estimateTokens(rendered.L2_doc_content));

  // ---- 决定缓存断点（需要先有各层哈希，故在构造消息之前算）----
  /*
   * 最小可缓存长度。
   *
   * 1024 是 OpenAI / Anthropic 量级服务商的典型门槛（各家略有差异：
   * Anthropic 是 1024，OpenAI 是 1024 起、按 128 递增）。
   * 允许调用方覆盖，是为了两件事：
   *  1. 测试能**显式**构造"低于门槛"的场景，而不是靠"默认人设恰好多短" ——
   *     后者会随 renderPersona 的措辞变化而静默失效（真实发生过）；
   *  2. 将来按模型配置这个值时不用再改这里。
   */
  const minimumCacheableTokens = input.cacheFloorTokens ?? 1024;
  const decision = decideBreakpoints(layers, input.previousLayerHashes, minimumCacheableTokens);
  breakpointDecision.layer = decision.breakpointLayer;
  breakpointDecision.reason = decision.reason;

  const breakpointAt = (name: LayerName) => breakpointDecision.layer === name;

  // ---- 组装消息序列 ----
  const messages: ChatMessage[] = [];

  if (rendered.L0_persona) {
    messages.push({
      role: "system",
      content: rendered.L0_persona,
      layer: "L0_persona",
      cacheControl: breakpointAt("L0_persona") ? { type: "ephemeral" } : undefined,
    });
  }
  if (rendered.L1_workspace) {
    messages.push({
      role: "system",
      content: rendered.L1_workspace,
      layer: "L1_workspace",
      cacheControl: breakpointAt("L1_workspace") ? { type: "ephemeral" } : undefined,
    });
  }

  // 知识块清单与正文合并进同一条 user 消息里的两个文本块。
  // 合并的理由：Anthropic 要求 user/assistant 交替，连续两条 user
  // 会被适配器合并；提前合并可让 OpenAI 系的 messages 数组也更紧凑，
  // 同时保持"清单在前、正文在后"的稳定内部顺序。
  const sourceParts: string[] = [];
  if (rendered.L2_source_index) sourceParts.push(rendered.L2_source_index);
  if (rendered.L2_source_content) sourceParts.push(rendered.L2_source_content);
  const sourceText = sourceParts.join("\n\n");

  if (sourceText) {
    messages.push({
      role: "user",
      content: sourceText,
      layer: "L2_source_content",
      cacheControl: breakpointAt("L2_source_content") ? { type: "ephemeral" } : undefined,
    });
  }

  // 模块清单与正文同理合并成一条 user 消息
  const docParts: string[] = [];
  if (rendered.L2_doc_index) docParts.push(rendered.L2_doc_index);
  if (rendered.L2_doc_content) docParts.push(rendered.L2_doc_content);
  const docText = docParts.join("\n\n");

  if (docText) {
    messages.push({
      role: "user",
      content: docText,
      layer: "L2_doc_content",
      cacheControl: breakpointAt("L2_doc_content") ? { type: "ephemeral" } : undefined,
    });
  }

  // L3 历史：只追加。断点若落在 L3，打在**最后一条**历史消息上，
  // 下一轮它仍在历史中段，断点覆盖的前缀依然有效。
  input.history.forEach((msg, index) => {
    const isLastHistory = index === input.history.length - 1;
    messages.push({
      role: msg.role,
      content: msg.content,
      layer: "L3_history",
      cacheControl:
        breakpointAt("L3_history") && isLastHistory ? { type: "ephemeral" } : undefined,
    });
  });

  // L4 本轮输入
  messages.push({ role: "user", content: rendered.L4_turn, layer: "L4_turn" });

  // ---- L3/L4 的 token 与哈希（按消息粒度累加后作为一层参与哈希链）----
  const historyTokens = input.history.reduce(
    (sum, m) => sum + estimateTokens(m.content) + MESSAGE_OVERHEAD_TOKENS,
    0,
  );
  const historyHashInput = input.history.map((m) => `${m.role}:${m.content}`).join("\n\u0001\n");
  // 注意：L3 的哈希必须在 L3 消息进入消息数组之后才能确定断点，
  // 这里用独立的哈希链位置补算，保证层顺序仍与 LAYER_ORDER 一致。
  // 插入点要落在**最后一个 L2 层之后** —— 加了模块层之后，
  // 写死 L2_source_content 会让 L3 插到模块层前面，层顺序就错了。
  const lastDocLayerAt = layers.findIndex((l) => l.name === "L2_doc_content");
  const l3InsertAt =
    (lastDocLayerAt >= 0 ? lastDocLayerAt : layers.findIndex((l) => l.name === "L2_source_content")) + 1;
  const l3Prev = layers[l3InsertAt - 1]?.prefixHash ?? sha256("nodes/context/v1");
  const l3Hash = chainHash(l3Prev, "L3_history", historyHashInput);
  layers.splice(l3InsertAt, 0, {
    name: "L3_history",
    title: LAYER_META.L3_history.title,
    text: historyHashInput,
    tokens: historyTokens,
    hash: l3Hash,
    prefixHash: l3Hash,
    unchangedFromPrevious: input.previousLayerHashes?.L3_history === l3Hash,
    hasBreakpoint: breakpointAt("L3_history"),
  });

  const l4Hash = chainHash(l3Hash, "L4_turn", rendered.L4_turn);
  layers.push({
    name: "L4_turn",
    title: LAYER_META.L4_turn.title,
    text: rendered.L4_turn,
    tokens: estimateTokens(rendered.L4_turn),
    hash: l4Hash,
    prefixHash: l4Hash,
    unchangedFromPrevious: input.previousLayerHashes?.L4_turn === l4Hash,
    hasBreakpoint: false,
  });

  // 标记各层的断点状态（L0/L1/L2 在 pushLayer 之后才定的断点）
  for (const l of layers) {
    if (LAYER_META[l.name].breakpointCandidate) l.hasBreakpoint = breakpointAt(l.name);
  }

  prefixHash = l4Hash;

  // ---- 命中预测 ----
  const meaningful = layers.filter((l) => l.tokens > 0);
  const hasPrevious = !!input.previousLayerHashes && Object.keys(input.previousLayerHashes).length > 0;

  // 最长公共前缀：从 L0 起连续 unchanged 的层
  let matchedTokens = 0;
  let fromLayer: LayerName = "L4_turn";
  let changed = false;
  for (const l of meaningful) {
    if (!changed && l.unchangedFromPrevious) {
      matchedTokens += l.tokens;
    } else if (!changed) {
      // 第一个与上一轮不同的层，就是本次失效的起点
      fromLayer = l.name;
      changed = true;
    }
  }

  const totalInputTokens = meaningful.reduce((sum, l) => sum + l.tokens, 0);
  const stablePrefixTokens = matchedTokens;

  // 服务商按块粒度对齐，不足一块的尾部不会被缓存；向下取整给出保守预测
  const alignedPrefix = Math.floor(matchedTokens / blockSize) * blockSize;
  /*
   * ⚠️ `Math.max(0, …)` 是必须的。
   *
   * `previousPromptTokens` 来自上一轮 invocation 的 `prompt_tokens + completion_tokens`，
   * 而那是数据库里的 `INTEGER` 列，没有非负约束。一旦它是负数（数据被手改、
   * 或将来某个统计口径出错写入负值），`Math.min` 会原样传下去，于是：
   *   predictedCachedTokens = -5000
   *   predictedWriteTokens  = totalInput - (-5000) = totalInput + 5000  ← 比输入还多
   * 屏幕上同时出现「命中 -5000」和「写入 > 输入」，两个都不可能存在。
   *
   * 这是同一类缺陷的第三次出现（前两次：缓存门槛只归零了写入、
   * 以及 null 地址被当成合法值）—— 判据必须作用在**每一个**输入上，
   * 不能只作用在"看起来可疑"的那个。
   */
  const previousPrompt = Math.max(0, input.previousPromptTokens ?? 0);
  // 能被复用的上限是"上一轮真正写进缓存的那部分"，而不是本轮前缀长度 ——
  // 前缀比上一轮更长时，多出来的部分是本轮才写入的，不可能被"读取"。
  const reusableFromPrevious = Math.max(0, Math.min(alignedPrefix, previousPrompt));

  // 缓存有生效门槛：稳定前缀达不到服务商最小可缓存长度时，
  // 缓存机制根本不参与计费，这与"算了但命中 0"必须区分开。
  const belowCacheFloor = matchedTokens < minimumCacheableTokens;

  /*
   * ⚠️ 低于门槛时，命中与写入**必须一起归零**。
   *
   * 这里曾经只把 `predictedWriteTokens` 归了零，`predictedCachedTokens`
   * 仍按前缀长度算 —— 那是自相矛盾的：这一轮既然什么都没写进缓存
   * （写入=0），就不可能从缓存里读出东西来。表现是界面上同时出现
   * 「命中 128 token」和「写入 0 token」，用户看到的是一个不可能的状态。
   *
   * 根因是门槛判定发生在计算之后、只作用于其中一个字段。现在把它提到前面，
   * 两个字段共用同一个判据。
   */
  const predictedCachedTokens = belowCacheFloor ? 0 : reusableFromPrevious;

  let verdict: CacheVerdict;
  if (!hasPrevious) verdict = "cold";
  else if (belowCacheFloor || predictedCachedTokens <= 0) verdict = "cold";
  else if (predictedCachedTokens >= totalInputTokens - blockSize) verdict = "hit";
  else verdict = "partial";

  const prediction: CachePrediction = {
    verdict,
    predictedCachedTokens,
    predictedWriteTokens: belowCacheFloor
      ? 0
      : Math.max(0, totalInputTokens - predictedCachedTokens),
    predictedMissTokens: Math.max(0, totalInputTokens - predictedCachedTokens),
    stablePrefixTokens,
    totalInputTokens,
    belowCacheFloor,
    cacheFloorTokens: minimumCacheableTokens,
  };

  // ---- 失效根因 ----
  let invalidation: InvalidationCause;
  if (!hasPrevious) {
    invalidation = {
      fromLayer: "L0_persona",
      reason: "cold_start",
      detail: "首轮对话，需要先建立缓存（本轮按全价计费）。",
    };
  } else if (!changed) {
    invalidation = {
      fromLayer: "L4_turn",
      reason: "none",
      detail: "所有层与上一轮一致（仅本轮提问不同），预期全部命中缓存。",
    };
  } else {
    const reasonMap: Partial<Record<LayerName, InvalidationCause["reason"]>> = {
      L0_persona: "persona_changed",
      L1_workspace: "conventions_changed",
      L2_source_index: "refs_changed",
      L2_source_content: "block_edited",
      L3_history: "history_rewritten",
    };
    const reason = reasonMap[fromLayer] ?? "refs_changed";
    const detailMap: Partial<Record<LayerName, string>> = {
      L0_persona: "人设被修改，L0 之后的所有前缀失效。",
      L1_workspace: "工作区约定被修改，L1 之后的前缀失效（L0 仍可命中）。",
      L2_source_index: "引用的知识块集合发生变化（新增或移除了 @ 引用）。",
      L2_source_content:
        "某个被引用的知识块内容被编辑。提示：编辑高引用的块会显著降低缓存命中。",
      L3_history: "对话历史被改写。历史应只追加，改写会破坏缓存。",
    };
    invalidation = {
      fromLayer,
      reason,
      detail: detailMap[fromLayer] ?? "上下文发生变化。",
    };
  }

  if (totalInputTokens > input.contextWindow * 0.9) {
    warnings.push(
      `输入约 ${totalInputTokens} token，已接近模型上下文窗口 ${input.contextWindow}。建议减少 @ 引用或新建对话。`,
    );
  }
  if (omittedIds.size > 0) {
    warnings.push(
      `有 ${omittedIds.size} 个知识块因超出预算未展开正文，模型只能看到它们的存在与标题。`,
    );
  }

  const blockTokens = ordered.map((b) => ({
    id: b.id,
    path: b.path,
    tokens: estimateTokens(b.text),
  }));

  return {
    messages,
    layers,
    prefixHash,
    stablePrefixTokens,
    prediction,
    invalidation,
    omittedBlockIds: [...omittedIds].sort(),
    orderedBlockIds: ordered.map((b) => b.id),
    blockTokens,
    totalTokens: totalInputTokens,
    warnings,
  };
}
