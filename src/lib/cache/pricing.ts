/**
 * 成本与节省核算。
 *
 * 缓存命中率的最终价值要用**钱**来表达才有说服力，所以这里把
 * "如果不缓存要花多少"和"实际花了多少"都算出来。
 *
 * 价格单位统一为 **USD / 1M token**，来自 model_config 表（用户可改），
 * 未填写时回退到内置的常见模型价格表。
 */

import type { NormalizedUsage } from "../providers/types";

export interface Pricing {
  /** 未命中缓存的输入 token 单价 */
  input: number;
  /** 命中缓存的输入 token 单价 */
  cachedInput: number;
  /** 输出 token 单价 */
  output: number;
  /** 显式缓存写入单价（Anthropic 为 input 的 1.25 倍）；为 0 表示无写入成本 */
  cacheWrite: number;
}

export interface CostBreakdown {
  /** 实际花费（美元） */
  actualUsd: number;
  /** 假设完全不命中缓存会花的钱 */
  baselineUsd: number;
  /** 因缓存命中而省下的钱 */
  savedUsd: number;
  /** 命中率 = cachedTokens / promptTokens */
  hitRate: number;
  /**
   * 缓存盈亏平衡所需的复用次数。
   * 显式缓存需要先付写入溢价，若同一前缀复用次数低于此值反而是亏的。
   * 自动缓存的服务商（写入无溢价）恒为 1。
   */
  breakEvenReuses: number;
}

/**
 * 内置价格表（USD / 1M token），仅作为未配置时的兜底。
 * 数据会随服务商调价过期，UI 上会提示"以 model_config 中的配置为准"。
 */
export const PRICE_CATALOG: Record<string, Pricing> = {
  // ---- OpenAI ----
  "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10, cacheWrite: 0 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6, cacheWrite: 0 },
  "gpt-4.1": { input: 2.0, cachedInput: 0.5, output: 8, cacheWrite: 0 },
  "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6, cacheWrite: 0 },
  "o3-mini": { input: 1.1, cachedInput: 0.55, output: 4.4, cacheWrite: 0 },
  // ---- Anthropic（写入 1.25x，读取 0.1x）----
  "claude-sonnet-4-5": { input: 3, cachedInput: 0.3, output: 15, cacheWrite: 3.75 },
  "claude-sonnet-4": { input: 3, cachedInput: 0.3, output: 15, cacheWrite: 3.75 },
  "claude-opus-4-1": { input: 15, cachedInput: 1.5, output: 75, cacheWrite: 18.75 },
  "claude-haiku-4-5": { input: 1, cachedInput: 0.1, output: 5, cacheWrite: 1.25 },
  "claude-3-5-haiku": { input: 0.8, cachedInput: 0.08, output: 4, cacheWrite: 1 },
  // ---- DeepSeek（自动缓存，命中约 0.1x）----
  "deepseek-chat": { input: 0.27, cachedInput: 0.027, output: 1.1, cacheWrite: 0 },
  "deepseek-reasoner": { input: 0.55, cachedInput: 0.055, output: 2.19, cacheWrite: 0 },
  // ---- 其他国内模型 ----
  "moonshot-v1-8k": { input: 1.68, cachedInput: 0.168, output: 1.68, cacheWrite: 0 },
  "kimi-k2": { input: 0.6, cachedInput: 0.15, output: 2.5, cacheWrite: 0 },
  "glm-4-plus": { input: 0.7, cachedInput: 0.07, output: 0.7, cacheWrite: 0 },
  "qwen-max": { input: 1.6, cachedInput: 0.16, output: 6.4, cacheWrite: 0 },
  "qwen-plus": { input: 0.4, cachedInput: 0.04, output: 1.2, cacheWrite: 0 },
};

/** 按模型名做前缀匹配查价，支持 "gpt-4o-2024-11-20" 这类带日期的版本号 */
export function lookupPricing(model: string): Pricing | null {
  const key = model.trim().toLowerCase();
  if (PRICE_CATALOG[key]) return PRICE_CATALOG[key];
  // 最长前缀优先，避免 "gpt-4o" 抢走 "gpt-4o-mini" 的匹配
  const candidates = Object.keys(PRICE_CATALOG)
    .filter((k) => key.startsWith(k))
    .sort((a, b) => b.length - a.length);
  return candidates.length > 0 ? PRICE_CATALOG[candidates[0]] : null;
}

const PER_MILLION = 1_000_000;

/**
 * 计算一次调用的成本明细。
 *
 * 关键点：`promptTokens` 是输入总量（含命中与写入部分），
 * 因此未命中部分 = promptTokens - cachedTokens - cacheWriteTokens。
 */
export function computeCost(usage: NormalizedUsage, pricing: Pricing): CostBreakdown {
  const missTokens = Math.max(
    0,
    usage.promptTokens - usage.cachedTokens - usage.cacheWriteTokens,
  );

  const actualUsd =
    (missTokens * pricing.input +
      usage.cachedTokens * pricing.cachedInput +
      usage.cacheWriteTokens * pricing.cacheWrite +
      usage.completionTokens * pricing.output) /
    PER_MILLION;

  const baselineUsd =
    (usage.promptTokens * pricing.input + usage.completionTokens * pricing.output) /
    PER_MILLION;

  const savedUsd = Math.max(0, baselineUsd - actualUsd);
  const hitRate = usage.promptTokens > 0 ? usage.cachedTokens / usage.promptTokens : 0;

  return {
    actualUsd,
    baselineUsd,
    savedUsd,
    hitRate,
    breakEvenReuses: estimateBreakEven(pricing),
  };
}

/**
 * 显式缓存的盈亏平衡点。
 *
 * 写入付 W、命中省 (input - cachedInput)。首次写入相对不缓存多付
 * (W - input)，之后每次复用少付 (input - cachedInput)。
 * 因此需要 n 次复用满足 n*(input - cachedInput) >= (W - input)。
 */
export function estimateBreakEven(pricing: Pricing): number {
  const premium = pricing.cacheWrite - pricing.input;
  const perReuseSaving = pricing.input - pricing.cachedInput;
  if (premium <= 0) return 1; // 自动缓存无需写入溢价
  if (perReuseSaving <= 0) return Number.POSITIVE_INFINITY;
  return Math.ceil(premium / perReuseSaving) + 1;
}

/** 把美元格式化成便于阅读的字符串 */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return `$${usd.toExponential(2)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** 把 token 数格式化成便于阅读的字符串 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}
