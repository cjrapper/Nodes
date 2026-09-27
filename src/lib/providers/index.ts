/** 提供商注册表与配置解析。 */

import { anthropicProvider } from "./anthropic";
import { openAiCompatibleProvider } from "./openai";
import type { Provider, ProviderKind, ResolvedModelConfig } from "./types";
import { lookupPricing } from "../cache/pricing";
import type { ModelConfig } from "../db/types";

const REGISTRY: Record<ProviderKind, Provider> = {
  openai: openAiCompatibleProvider,
  anthropic: anthropicProvider,
};

export function getProvider(kind: ProviderKind): Provider {
  const provider = REGISTRY[kind];
  if (!provider) throw new Error(`未注册的提供商类型：${kind}`);
  return provider;
}

export function listProviderKinds(): { kind: ProviderKind; label: string }[] {
  return Object.values(REGISTRY).map((p) => ({ kind: p.kind, label: p.label }));
}

/**
 * 把库里的 ModelConfig 解析成可直接发起请求的配置。
 *
 * 价格缺省时会回退到内置价格表：用户往往只填 baseUrl 和 model，
 * 让成本核算开箱可用比强制填表更重要。
 */
export function resolveModelConfig(cfg: ModelConfig): ResolvedModelConfig {
  const fallback = lookupPricing(cfg.model);

  const inputPrice = cfg.inputPrice > 0 ? cfg.inputPrice : (fallback?.input ?? 0);
  const cachedInputPrice =
    cfg.cachedInputPrice > 0 ? cfg.cachedInputPrice : (fallback?.cachedInput ?? inputPrice / 10);
  const outputPrice = cfg.outputPrice > 0 ? cfg.outputPrice : (fallback?.output ?? 0);

  return {
    id: cfg.id,
    name: cfg.name,
    provider: cfg.provider,
    baseUrl: cfg.baseUrl.replace(/\/+$/, ""),
    apiKey: cfg.apiKey,
    model: cfg.model,
    temperature: cfg.temperature,
    // 库里可能存着 NULL（不限制）。这里统一收敛成 null，让适配器只需判一种"空值"
    maxTokens: cfg.maxTokens ?? null,
    contextWindow: cfg.contextWindow,
    supportsPromptCache: cfg.supportsPromptCache,
    inputPrice,
    cachedInputPrice,
    outputPrice,
    extra: cfg.extra ?? {},
  };
}

/** 显式缓存写入单价：Anthropic 为 input 的 1.25 倍，自动缓存的服务商为 0 */
export function cacheWritePrice(provider: ProviderKind, inputPrice: number): number {
  return provider === "anthropic" ? inputPrice * 1.25 : 0;
}
