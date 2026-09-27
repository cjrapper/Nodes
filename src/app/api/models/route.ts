import { json, maskApiKey, readJson, serverError } from "@/lib/api/http";
import { PRICE_CATALOG, lookupPricing } from "@/lib/cache/pricing";
import * as repo from "@/lib/db/repo";
import type { ProviderKind } from "@/lib/db/types";

/** 列出所有模型配置，API Key 只露尾四位 */
export async function GET() {
  try {
    const models = repo.listModelConfigs().map((m) => {
      const { apiKey, ...rest } = m;
      return { ...rest, ...maskApiKey(apiKey) };
    });
    return json({ models, priceCatalog: Object.keys(PRICE_CATALOG) });
  } catch (err) {
    return serverError(err);
  }
}

interface ModelBody {
  id?: string;
  name?: string;
  provider?: ProviderKind;
  baseUrl?: string;
  /** 传空字符串表示"保持不变"，避免前端拿着掩码值覆盖真实 key */
  apiKey?: string;
  model?: string;
  temperature?: number;
  /** `null` = 不限制输出；不传 = 新建时默认不限制 */
  maxTokens?: number | null;
  contextWindow?: number;
  supportsPromptCache?: boolean;
  inputPrice?: number;
  cachedInputPrice?: number;
  outputPrice?: number;
  extra?: Record<string, unknown>;
  isDefault?: boolean;
}

function normalizeProvider(value: unknown): ProviderKind {
  return value === "anthropic" ? "anthropic" : "openai";
}

export async function POST(request: Request) {
  try {
    const body = await readJson<ModelBody>(request);
    if (!body?.name?.trim()) return json({ error: "请填写配置名称" }, 400);
    if (!body.model?.trim()) return json({ error: "请填写模型 ID" }, 400);
    if (!body.baseUrl?.trim()) return json({ error: "请填写接口地址" }, 400);

    const provider = normalizeProvider(body.provider);
    // 价格留空时用内置价目表兜底，让成本核算开箱可用
    const fallback = lookupPricing(body.model);

    const created = repo.createModelConfig({
      name: body.name.trim(),
      provider,
      baseUrl: body.baseUrl.trim(),
      apiKey: (body.apiKey ?? "").trim(),
      model: body.model.trim(),
      temperature: body.temperature ?? 0.3,
      // 默认不限制输出。以前这里兜底 8192，而 8192 比服务商的原生默认还小，
      // 于是"什么都不填"反而制造了一个必然被思维链撞上的上限。
      maxTokens: body.maxTokens ?? null,
      contextWindow: body.contextWindow ?? 128000,
      supportsPromptCache: body.supportsPromptCache ?? true,
      inputPrice: body.inputPrice ?? fallback?.input ?? 0,
      cachedInputPrice: body.cachedInputPrice ?? fallback?.cachedInput ?? 0,
      outputPrice: body.outputPrice ?? fallback?.output ?? 0,
      extra: body.extra ?? {},
      isDefault: body.isDefault ?? false,
    });

    const { apiKey, ...rest } = created;
    return json({ model: { ...rest, ...maskApiKey(apiKey) } }, 201);
  } catch (err) {
    return serverError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await readJson<ModelBody>(request);
    if (!body?.id) return json({ error: "缺少 id" }, 400);

    const current = repo.getModelConfig(body.id);
    if (!current) return json({ error: "模型配置不存在" }, 404);

    const patch: Parameters<typeof repo.updateModelConfig>[1] = {};
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.provider !== undefined) patch.provider = normalizeProvider(body.provider);
    if (body.baseUrl !== undefined) patch.baseUrl = body.baseUrl.trim();
    // 空字符串 = 不改动 key。这样前端无需持有明文即可安全提交其他字段。
    if (body.apiKey !== undefined && body.apiKey.trim() !== "") {
      patch.apiKey = body.apiKey.trim();
    }
    if (body.model !== undefined) patch.model = body.model.trim();
    if (body.temperature !== undefined) patch.temperature = body.temperature;
    /*
     * ⚠️ 判据必须是 `!== undefined`，不能用真值判断。
     *
     * `maxTokens: null` 是一个**有意义的取值**（不限制），不是"没传"。
     * 写成 `if (body.maxTokens)` 的话，用户在界面上清空这个字段（提交 null）
     * 会被静默忽略，旧的上限留在库里 —— 界面显示空的、实际还在限制。
     */
    if (body.maxTokens !== undefined) patch.maxTokens = body.maxTokens;
    if (body.contextWindow !== undefined) patch.contextWindow = body.contextWindow;
    if (body.supportsPromptCache !== undefined) {
      patch.supportsPromptCache = body.supportsPromptCache;
    }
    if (body.inputPrice !== undefined) patch.inputPrice = body.inputPrice;
    if (body.cachedInputPrice !== undefined) patch.cachedInputPrice = body.cachedInputPrice;
    if (body.outputPrice !== undefined) patch.outputPrice = body.outputPrice;
    if (body.extra !== undefined) patch.extra = body.extra;
    if (body.isDefault !== undefined) patch.isDefault = body.isDefault;

    const updated = repo.updateModelConfig(body.id, patch);
    if (!updated) return json({ error: "更新失败" }, 500);

    const { apiKey, ...rest } = updated;
    return json({ model: { ...rest, ...maskApiKey(apiKey) } });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return json({ error: "缺少 id 参数" }, 400);
    const ok = repo.deleteModelConfig(id);
    return json({ ok });
  } catch (err) {
    return serverError(err);
  }
}
