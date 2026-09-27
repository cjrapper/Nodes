"use client";

/**
 * 模型配置管理面板（ModelsPanel）
 *
 * 关键决策说明：
 * 1. 新增 / 编辑复用同一个内部组件 `ModelForm`，用**内联展开**代替模态框：
 *    内联表单不需要焦点陷阱（focus trap）、不会被 Esc 与滚动锁打断，
 *    少一整类无障碍坑，也让「边看卡片边改参数」更顺手。
 * 2. apiKey 的空字符串语义（本面板最容易踩的坑）：
 *    GET 永远只返回掩码 `apiKeyHint`（如 "••••abcd"），前端**从不持有明文**。
 *    所以编辑提交时传空字符串 = "不要改动这个 key"；若把掩码串回填后提交，
 *    真实 key 就被掩码覆盖了。表单里编辑态固定留空并提示「留空表示不修改」。
 * 3. 价格字段留空 = **不提交该字段**：新建时后端用内置价目表兜底，
 *    编辑时保持原值不动（而不是被覆盖成 0）。
 * 4. 错误统一走页面内的错误条（`role="alert"`），不用 `window.alert`：
 *    后者会阻塞渲染、无法承载多条信息；只有删除二次确认按需求用 `window.confirm`。
 */

import clsx, { type ClassValue } from "clsx";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Coins,
  Cpu,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type * as React from "react";
import { twMerge } from "tailwind-merge";

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

type ProviderKind = "openai" | "anthropic";

/** `GET /api/models` 返回的模型视图；接口永远不返回明文 apiKey */
interface ModelView {
  id: string;
  name: string;
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  /** 是否已配置 key */
  apiKeySet: boolean;
  /** 形如 "••••abcd"，只露尾四位 */
  apiKeyHint: string;
  temperature: number;
  maxTokens: number;
  contextWindow: number;
  supportsPromptCache: boolean;
  inputPrice: number;
  cachedInputPrice: number;
  outputPrice: number;
  extra: Record<string, unknown>;
  isDefault: boolean;
}

interface ModelsResponse {
  models: ModelView[];
  priceCatalog: string[];
}

/**
 * POST / PATCH 的请求体。
 * POST 时后端会为缺省字段补默认值，因此可选的数值字段「缺失」是有意义的。
 */
interface ModelPayload {
  name: string;
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  /** 明文 key；PATCH 时传空字符串表示不修改 */
  apiKey: string;
  temperature: number;
  supportsPromptCache: boolean;
  isDefault: boolean;
  /** `null` = 不限制输出（请求不带 max_tokens） */
  maxTokens: number | null;
  contextWindow?: number;
  inputPrice?: number;
  cachedInputPrice?: number;
  outputPrice?: number;
  extra?: Record<string, unknown>;
}

/** 表单内部用字符串保存数字输入，才能区分「留空」和「填了 0」 */
interface FormState {
  name: string;
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  contextWindow: string;
  maxTokens: string;
  temperature: number;
  inputPrice: string;
  cachedInputPrice: string;
  outputPrice: string;
  supportsPromptCache: boolean;
  isDefault: boolean;
  /** 额外请求参数的原始 JSON 文本 */
  extraText: string;
}

type FieldName =
  | "name"
  | "baseUrl"
  | "model"
  | "contextWindow"
  | "maxTokens"
  | "inputPrice"
  | "cachedInputPrice"
  | "outputPrice"
  | "extra";

type FieldErrors = Partial<Record<FieldName, string>>;

type FormMode =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; model: ModelView };

interface CardBusy {
  id: string;
  action: "default" | "delete";
}

/* ------------------------------------------------------------------ */
/* 常量与纯函数工具                                                     */
/* ------------------------------------------------------------------ */

const PROVIDER_LABEL: Record<ProviderKind, string> = {
  openai: "OpenAI 兼容",
  anthropic: "Anthropic 原生",
};

/** 切换接口类型时自动填入的默认地址（用户可再手动改写） */
const PROVIDER_DEFAULT_BASE_URL: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isErrorBody(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "string"
  );
}

/** 统一的请求封装：把 `{ error }` 响应体转成 Error 抛给调用方 */
async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, { cache: "no-store", ...init });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      isErrorBody(data) ? data.error : `请求失败（HTTP ${res.status}）`,
    );
  }
  return data as T;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** 价格量级跨度很大（0.027 ~ 75），统一去掉多余的尾随零 */
function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  return `$${Number(value.toFixed(4))}`;
}

/**
 * 解析可选数字输入。
 * - 空字符串 → `undefined`：不提交该字段，交给后端兜底 / 保持原值
 * - 非法值 → 返回中文错误信息
 */
function parseOptionalNumber(
  raw: string,
  opts: { label: string; min: number; integer?: boolean },
): { value?: number; error?: string } {
  const text = raw.trim();
  if (text === "") return {};
  const value = Number(text);
  if (!Number.isFinite(value)) return { error: `${opts.label}必须是数字` };
  if (value < opts.min) return { error: `${opts.label}不能小于 ${opts.min}` };
  if (opts.integer && !Number.isInteger(value)) {
    return { error: `${opts.label}必须是整数` };
  }
  return { value };
}

function clampTemperature(value: number): number {
  if (!Number.isFinite(value)) return 0.3;
  return Math.min(2, Math.max(0, value));
}

/** ModelView → 表单初始状态（编辑态 apiKey 固定留空，见文件头说明第 2 条） */
function toFormState(initial: ModelView | null): FormState {
  if (!initial) {
    return {
      name: "",
      provider: "openai",
      baseUrl: PROVIDER_DEFAULT_BASE_URL.openai,
      model: "",
      apiKey: "",
      contextWindow: "128000",
      /*
       * 留空 = 不限制输出。
       *
       * 这里曾经是 "8192"，理由是"推理模型的思维链与正文共用这个预算，4096 不够"。
       * 但 8192 同样不够，而且比服务商的原生默认还小（DeepSeek 思考模式是 64K）——
       * 用户照样在「AI 分析」上看到"思考完了、正文没额度了"。
       *
       * **只要还填着具体数字，思维链够长就一定能把它烧完**，所以默认必须是"不限制"。
       */
      maxTokens: "",
      temperature: 0.3,
      inputPrice: "",
      cachedInputPrice: "",
      outputPrice: "",
      supportsPromptCache: true,
      isDefault: false,
      extraText: "",
    };
  }

  const hasExtra = Object.keys(initial.extra ?? {}).length > 0;
  return {
    name: initial.name,
    provider: initial.provider,
    baseUrl: initial.baseUrl,
    model: initial.model,
    // 永远不回填明文：留空 = 不修改
    apiKey: "",
    contextWindow: String(initial.contextWindow),
    // null 渲染成空输入框，配合下面的提示表达"不限制"
    maxTokens: initial.maxTokens === null ? "" : String(initial.maxTokens),
    temperature: clampTemperature(initial.temperature),
    inputPrice: String(initial.inputPrice),
    cachedInputPrice: String(initial.cachedInputPrice),
    outputPrice: String(initial.outputPrice),
    supportsPromptCache: initial.supportsPromptCache,
    isDefault: initial.isDefault,
    extraText: hasExtra ? JSON.stringify(initial.extra, null, 2) : "",
  };
}

/** 表单校验：返回错误集合与（校验通过时的）请求体 */
function validateForm(form: FormState): {
  errors: FieldErrors;
  payload: ModelPayload | null;
} {
  const errors: FieldErrors = {};

  if (form.name.trim() === "") errors.name = "请填写配置名称";
  if (form.baseUrl.trim() === "") errors.baseUrl = "请填写接口地址";
  if (form.model.trim() === "") errors.model = "请填写模型 ID";

  const contextWindow = parseOptionalNumber(form.contextWindow, {
    label: "上下文窗口",
    min: 1,
    integer: true,
  });
  if (contextWindow.error) errors.contextWindow = contextWindow.error;

  /*
   * ⚠️ 最大输出**不走** `parseOptionalNumber`，因为它对"留空"的语义和别的字段相反。
   *
   * 别的字段留空 = "别动这个值"；最大输出留空 = "不限制"，必须**主动提交 null**，
   * 否则用户把 8192 删空之后请求体里没有这个字段，后端保持原值 ——
   * 界面上明明空了，实际还在限制，这是最难查的一类故障（接口成功、数据没改）。
   */
  const maxTokensText = form.maxTokens.trim();
  let maxTokensValue: number | null = null;
  if (maxTokensText !== "") {
    const parsed = Number(maxTokensText);
    if (!Number.isFinite(parsed)) errors.maxTokens = "最大输出 token 必须是数字";
    else if (parsed < 1) errors.maxTokens = "最大输出 token 不能小于 1";
    else if (!Number.isInteger(parsed)) errors.maxTokens = "最大输出 token 必须是整数";
    else maxTokensValue = parsed;
  }

  const inputPrice = parseOptionalNumber(form.inputPrice, {
    label: "输入价格",
    min: 0,
  });
  if (inputPrice.error) errors.inputPrice = inputPrice.error;

  const cachedInputPrice = parseOptionalNumber(form.cachedInputPrice, {
    label: "缓存命中价格",
    min: 0,
  });
  if (cachedInputPrice.error) errors.cachedInputPrice = cachedInputPrice.error;

  const outputPrice = parseOptionalNumber(form.outputPrice, {
    label: "输出价格",
    min: 0,
  });
  if (outputPrice.error) errors.outputPrice = outputPrice.error;

  // 额外参数必须先在本地 JSON.parse 校验通过才允许提交
  let extra: Record<string, unknown> | undefined;
  const extraText = form.extraText.trim();
  if (extraText !== "") {
    try {
      const parsed: unknown = JSON.parse(extraText);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        errors.extra = '额外参数必须是一个 JSON 对象，例如 {"top_p": 0.9}';
      } else {
        extra = parsed as Record<string, unknown>;
      }
    } catch (err) {
      errors.extra = `JSON 解析失败：${toMessage(err)}`;
    }
  }

  if (Object.keys(errors).length > 0) return { errors, payload: null };

  const payload: ModelPayload = {
    name: form.name.trim(),
    provider: form.provider,
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    // 新建时空字符串 = 该服务不需要 key（如本地 Ollama）；
    // 编辑时空字符串 = 服务端保持原 key 不变
    apiKey: form.apiKey.trim(),
    temperature: clampTemperature(form.temperature),
    supportsPromptCache: form.supportsPromptCache,
    isDefault: form.isDefault,
    // 总是显式提交：数字 = 上限，null = 不限制（见上面那段注释）
    maxTokens: maxTokensValue,
  };
  // 留空的字段直接不放进请求体，让后端兜底 / 保持原值
  if (contextWindow.value !== undefined) payload.contextWindow = contextWindow.value;
  if (inputPrice.value !== undefined) payload.inputPrice = inputPrice.value;
  if (cachedInputPrice.value !== undefined) {
    payload.cachedInputPrice = cachedInputPrice.value;
  }
  if (outputPrice.value !== undefined) payload.outputPrice = outputPrice.value;
  if (extra !== undefined) payload.extra = extra;

  return { errors, payload };
}

/* ------------------------------------------------------------------ */
/* 通用小部件                                                          */
/* ------------------------------------------------------------------ */

const INPUT_CLASS =
  "w-full rounded-lg border border-[#23282f] bg-[#0b0d10] px-3 py-2 text-sm text-[var(--nodes-ink)] placeholder:text-[var(--nodes-ink-faint)] transition-colors focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#3ddc97] disabled:cursor-not-allowed disabled:opacity-50";

const PRIMARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#3ddc97] px-3 py-2 text-sm font-medium text-[#0b0d10] transition-colors hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-[#3ddc97] focus:ring-offset-2 focus:ring-offset-[#12151a] disabled:cursor-not-allowed disabled:opacity-50";

const GHOST_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#23282f] bg-[#171b21] px-3 py-2 text-sm text-[var(--nodes-ink)] transition-colors hover:border-[#2c333c] hover:bg-[#1e232a] focus:outline-none focus:ring-2 focus:ring-[#3ddc97] disabled:cursor-not-allowed disabled:opacity-50";

const DANGER_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#23282f] bg-transparent px-3 py-2 text-sm text-[#f2555a] transition-colors hover:border-[#f2555a]/50 hover:bg-[#f2555a]/10 focus:outline-none focus:ring-2 focus:ring-[#f2555a] disabled:cursor-not-allowed disabled:opacity-50";

/** 错误 / 警告条：显眼、可关闭、对读屏软件友好 */
function NoticeBanner({
  message,
  tone = "danger",
  onDismiss,
}: {
  message: string;
  tone?: "danger" | "warning";
  onDismiss?: () => void;
}): React.JSX.Element {
  const isDanger = tone === "danger";
  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed",
        isDanger
          ? "border-[#f2555a]/40 bg-[#f2555a]/10 text-[#f2555a]"
          : "border-[#f5b544]/40 bg-[#f5b544]/10 text-[#f5b544]",
      )}
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">{message}</p>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭提示"
          className="shrink-0 rounded-lg p-0.5 transition-colors hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-[#3ddc97]"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function Field({
  id,
  label,
  required = false,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: React.ReactNode;
  error?: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-xs font-medium text-[var(--nodes-ink-dim)]">
        {label}
        {required ? <span className="text-[#f2555a]"> *</span> : null}
      </label>
      {children}
      {hint ? (
        <p className="text-[11px] leading-relaxed text-[var(--nodes-ink-faint)]">{hint}</p>
      ) : null}
      {error ? (
        <p className="flex items-center gap-1 text-[11px] text-[#f2555a]">
          <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** 单个价格展示格 */
function PriceCell({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: number;
  accent?: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-[#23282f] bg-[#12151a] px-3 py-2">
      <p className="text-[11px] text-[var(--nodes-ink-faint)]">{label}</p>
      <p
        className={cn(
          "mt-0.5 font-mono text-sm tabular-nums",
          accent ? "text-[#3ddc97]" : "text-[var(--nodes-ink)]",
        )}
      >
        {formatPrice(value)}
      </p>
    </div>
  );
}

function SkeletonCard(): React.JSX.Element {
  return (
    <li
      aria-hidden="true"
      className="animate-pulse rounded-xl border border-[#23282f] bg-[#171b21] p-4"
    >
      <div className="h-4 w-40 rounded-lg bg-[#23282f]" />
      <div className="mt-3 h-3 w-64 max-w-full rounded-lg bg-[#23282f]" />
      <div className="mt-2 h-3 w-52 max-w-full rounded-lg bg-[#23282f]" />
      <div className="mt-4 grid grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 rounded-lg bg-[#23282f]" />
        ))}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* 模型卡片                                                            */
/* ------------------------------------------------------------------ */

function ModelCard({
  model,
  busyAction,
  actionsDisabled,
  onEdit,
  onSetDefault,
  onDelete,
}: {
  model: ModelView;
  busyAction: CardBusy["action"] | null;
  actionsDisabled: boolean;
  onEdit: (model: ModelView) => void;
  onSetDefault: (model: ModelView) => void;
  onDelete: (model: ModelView) => void;
}): React.JSX.Element {
  const isOpenAi = model.provider === "openai";
  const isBusy = busyAction !== null;
  const extraCount = Object.keys(model.extra ?? {}).length;
  const pricesUnset =
    model.inputPrice === 0 && model.cachedInputPrice === 0 && model.outputPrice === 0;

  return (
    <li
      className={cn(
        "rounded-xl border bg-[#171b21] p-4 transition-colors",
        model.isDefault
          ? "border-[#3ddc97]/60"
          : "border-[#23282f] hover:border-[#2c333c]",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* 左：名称 + 徽标 + 元信息 */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-[var(--nodes-ink)]">
              {model.name}
            </h3>

            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px]",
                isOpenAi
                  ? "border-[#3ddc97]/40 bg-[#3ddc97]/10 text-[#3ddc97]"
                  : "border-[#23282f] bg-[#12151a] text-[var(--nodes-ink-dim)]",
              )}
            >
              {isOpenAi ? (
                <Cpu className="h-3 w-3" aria-hidden="true" />
              ) : (
                <Server className="h-3 w-3" aria-hidden="true" />
              )}
              {PROVIDER_LABEL[model.provider]}
            </span>

            {model.isDefault ? (
              <span className="inline-flex items-center gap-1 rounded-lg border border-[#3ddc97]/40 bg-[#3ddc97]/10 px-2 py-0.5 text-[11px] text-[#3ddc97]">
                <Star className="h-3 w-3" aria-hidden="true" />
                默认模型
              </span>
            ) : null}

            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px]",
                model.supportsPromptCache
                  ? "border-[#23282f] bg-[#12151a] text-[var(--nodes-ink-dim)]"
                  : "border-[#f5b544]/40 bg-[#f5b544]/10 text-[#f5b544]",
              )}
            >
              {model.supportsPromptCache ? "前缀缓存已启用" : "缓存已关闭"}
            </span>
          </div>

          <dl className="mt-3 grid gap-1 text-xs sm:grid-cols-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <dt className="shrink-0 text-[var(--nodes-ink-faint)]">模型 ID</dt>
              <dd
                className="truncate font-mono text-[var(--nodes-ink)]"
                title={model.model}
              >
                {model.model}
              </dd>
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <dt className="shrink-0 text-[var(--nodes-ink-faint)]">接口地址</dt>
              <dd
                className="truncate font-mono text-[var(--nodes-ink-dim)]"
                title={model.baseUrl}
              >
                {model.baseUrl}
              </dd>
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <dt className="shrink-0 text-[var(--nodes-ink-faint)]">API Key</dt>
              <dd className="truncate">
                {model.apiKeySet ? (
                  <span className="inline-flex items-center gap-1 text-[#3ddc97]">
                    <Check className="h-3 w-3" aria-hidden="true" />
                    已配置
                    <span className="font-mono text-[var(--nodes-ink-dim)]">
                      {model.apiKeyHint}
                    </span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[#f5b544]">
                    <AlertCircle className="h-3 w-3" aria-hidden="true" />
                    未配置（本地模型可忽略）
                  </span>
                )}
              </dd>
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <dt className="shrink-0 text-[var(--nodes-ink-faint)]">参数</dt>
              <dd className="truncate text-[var(--nodes-ink-dim)]">
                温度 {model.temperature} · 上下文{" "}
                {model.contextWindow.toLocaleString("en-US")} · 输出{" "}
                {model.maxTokens === null ? (
                  <span className="text-[#3ddc97]">不限制</span>
                ) : (
                  <>上限 {model.maxTokens.toLocaleString("en-US")}</>
                )}
                {extraCount > 0 ? ` · 额外参数 ${extraCount} 项` : ""}
              </dd>
            </div>
          </dl>
        </div>

        {/* 右：操作 */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onEdit(model)}
            disabled={actionsDisabled}
            aria-label={`编辑模型 ${model.name}`}
            className={cn(GHOST_BUTTON_CLASS, "px-2.5 py-1.5 text-xs")}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            编辑
          </button>

          <button
            type="button"
            onClick={() => onSetDefault(model)}
            disabled={actionsDisabled || model.isDefault}
            aria-label={`把 ${model.name} 设为默认模型`}
            className={cn(GHOST_BUTTON_CLASS, "px-2.5 py-1.5 text-xs")}
          >
            {busyAction === "default" ? (
              <Loader2
                className="h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Star className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {model.isDefault ? "已是默认" : "设为默认"}
          </button>

          <button
            type="button"
            onClick={() => onDelete(model)}
            disabled={actionsDisabled}
            aria-label={`删除模型 ${model.name}`}
            className={cn(DANGER_BUTTON_CLASS, "px-2.5 py-1.5 text-xs")}
          >
            {busyAction === "delete" ? (
              <Loader2
                className="h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            删除
          </button>
        </div>
      </div>

      {/* 三档价格（USD / 100 万 token） */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-[var(--nodes-ink-faint)]">
          <Coins className="h-3 w-3" aria-hidden="true" />
          价格单位：USD / 100 万 token
        </div>
        <div className="grid grid-cols-3 gap-3">
          <PriceCell label="输入（未命中）" value={model.inputPrice} />
          <PriceCell
            label="缓存命中"
            value={model.cachedInputPrice}
            accent
          />
          <PriceCell label="输出" value={model.outputPrice} />
        </div>
        {pricesUnset ? (
          <p className="mt-2 flex items-center gap-1 text-[11px] text-[#f5b544]">
            <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
            三档价格都是 0，成本与节省统计会显示为 $0，建议填入实际单价。
          </p>
        ) : null}
      </div>

      {isBusy ? (
        <p role="status" aria-live="polite" className="sr-only">
          正在处理 {model.name}
        </p>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* 新增 / 编辑表单                                                     */
/* ------------------------------------------------------------------ */

function ModelForm({
  initial,
  priceCatalog,
  submitting,
  submitError,
  onSubmit,
  onCancel,
}: {
  /** null = 新建 */
  initial: ModelView | null;
  priceCatalog: string[];
  submitting: boolean;
  /** 父组件保存失败时的错误信息（保存成功会关闭表单） */
  submitError: string | null;
  onSubmit: (payload: ModelPayload) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const uid = useId();
  const fieldId = (name: string): string => `${uid}-${name}`;

  const [form, setForm] = useState<FormState>(() => toFormState(initial));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [showKey, setShowKey] = useState(false);

  const isEdit = initial !== null;

  const patchForm = useCallback((patch: Partial<FormState>): void => {
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const clearError = useCallback((name: FieldName): void => {
    setErrors((prev) => {
      if (prev[name] === undefined) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }, []);

  /** 切换接口类型 → 自动填入该类型的默认 baseUrl（可再手动改写） */
  const handleProviderChange = (next: ProviderKind): void => {
    patchForm({ provider: next, baseUrl: PROVIDER_DEFAULT_BASE_URL[next] });
    clearError("baseUrl");
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (submitting) return;
    const { errors: found, payload } = validateForm(form);
    if (payload === null) {
      setErrors(found);
      return;
    }
    setErrors({});
    onSubmit(payload);
  };

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-labelledby={fieldId("form-title")}
      className="rounded-xl border border-[#23282f] bg-[#171b21] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id={fieldId("form-title")}
          className="flex items-center gap-1.5 text-sm font-semibold text-[var(--nodes-ink)]"
        >
          {isEdit ? (
            <Pencil className="h-3.5 w-3.5 text-[#3ddc97]" aria-hidden="true" />
          ) : (
            <Plus className="h-3.5 w-3.5 text-[#3ddc97]" aria-hidden="true" />
          )}
          {isEdit ? `编辑「${initial.name}」` : "添加模型"}
        </h3>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          aria-label="关闭表单"
          className={cn(GHOST_BUTTON_CLASS, "px-2.5 py-1.5 text-xs")}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          取消
        </button>
      </div>

      {submitError ? (
        <div className="mt-3">
          <NoticeBanner message={submitError} onDismiss={onCancel} />
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field
          id={fieldId("name")}
          label="配置名称"
          required
          error={errors.name}
          hint="只用于界面展示，例如「DeepSeek 主力」"
        >
          <input
            id={fieldId("name")}
            type="text"
            value={form.name}
            disabled={submitting}
            placeholder="DeepSeek 主力"
            autoComplete="off"
            onChange={(e) => {
              patchForm({ name: e.target.value });
              clearError("name");
            }}
            className={INPUT_CLASS}
          />
        </Field>

        <Field
          id={fieldId("provider")}
          label="接口类型"
          hint="切换类型会自动填入该类型的默认接口地址，可手动改写"
        >
          <select
            id={fieldId("provider")}
            value={form.provider}
            disabled={submitting}
            onChange={(e) =>
              handleProviderChange(e.target.value as ProviderKind)
            }
            className={cn(INPUT_CLASS, "appearance-none")}
          >
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic 原生</option>
          </select>
        </Field>

        <Field
          id={fieldId("baseUrl")}
          label="接口地址（baseUrl）"
          required
          error={errors.baseUrl}
        >
          <input
            id={fieldId("baseUrl")}
            type="url"
            value={form.baseUrl}
            disabled={submitting}
            placeholder={PROVIDER_DEFAULT_BASE_URL[form.provider]}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              patchForm({ baseUrl: e.target.value });
              clearError("baseUrl");
            }}
            className={cn(INPUT_CLASS, "font-mono")}
          />
        </Field>

        <Field
          id={fieldId("model")}
          label="模型 ID"
          required
          error={errors.model}
          hint="请求里实际发送的 model 字段。必须填服务商的**接口模型名**，不是产品名或显示名 —— 例如 DeepSeek 要填 deepseek-chat / deepseek-flash，填成 DeepSeek-V4.1-Flash 会被服务商返回 400。"
        >
          <input
            id={fieldId("model")}
            type="text"
            value={form.model}
            disabled={submitting}
            placeholder="deepseek-chat"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              patchForm({ model: e.target.value });
              clearError("model");
            }}
            className={cn(INPUT_CLASS, "font-mono")}
          />
        </Field>

        <Field
          id={fieldId("apiKey")}
          label="API Key"
          className="sm:col-span-2"
          hint={
            isEdit
              ? `留空表示不修改（当前：${
                  initial.apiKeySet ? initial.apiKeyHint : "未配置"
                }）。接口只返回掩码，明文不会回填。`
              : "本地模型（Ollama / vLLM 等）可以留空。Key 只保存在本地数据库。"
          }
        >
          <div className="relative">
            <input
              id={fieldId("apiKey")}
              type={showKey ? "text" : "password"}
              value={form.apiKey}
              disabled={submitting}
              placeholder={isEdit ? "留空表示不修改" : "sk-..."}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => patchForm({ apiKey: e.target.value })}
              className={cn(INPUT_CLASS, "pr-11 font-mono")}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              disabled={submitting}
              aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
              aria-pressed={showKey}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-lg p-1.5 text-[var(--nodes-ink-dim)] transition-colors hover:bg-[#23282f] hover:text-[var(--nodes-ink)] focus:outline-none focus:ring-2 focus:ring-[#3ddc97] disabled:opacity-50"
            >
              {showKey ? (
                <EyeOff className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Eye className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </Field>

        <Field
          id={fieldId("contextWindow")}
          label="上下文窗口（token）"
          error={errors.contextWindow}
        >
          <input
            id={fieldId("contextWindow")}
            type="number"
            min={1}
            step={1000}
            inputMode="numeric"
            value={form.contextWindow}
            disabled={submitting}
            onChange={(e) => {
              patchForm({ contextWindow: e.target.value });
              clearError("contextWindow");
            }}
            className={cn(INPUT_CLASS, "font-mono tabular-nums")}
          />
        </Field>

        <Field
          id={fieldId("maxTokens")}
          label="最大输出 token（可留空）"
          error={errors.maxTokens}
          hint={
            <>
              <strong className="text-[var(--nodes-ink-dim)]">留空 = 不限制</strong>
              ：请求里不带 <code>max_tokens</code>，由服务商按自己的上限约束。
              推理模型的思维链与正文<strong className="text-[var(--nodes-ink-dim)]">共用</strong>
              这个预算，填一个具体数字迟早被思考烧完
              （填 8192 就等于把 DeepSeek 思考模式的原生 64K 砍到 1/8）。
            </>
          }
        >
          <div className="flex items-center gap-2">
            <input
              id={fieldId("maxTokens")}
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              placeholder="不限制"
              value={form.maxTokens}
              disabled={submitting}
              onChange={(e) => {
                patchForm({ maxTokens: e.target.value });
                clearError("maxTokens");
              }}
              className={cn(INPUT_CLASS, "font-mono tabular-nums")}
            />
            {form.maxTokens.trim() === "" ? null : (
              <button
                type="button"
                onClick={() => {
                  patchForm({ maxTokens: "" });
                  clearError("maxTokens");
                }}
                disabled={submitting}
                className={cn(GHOST_BUTTON_CLASS, "shrink-0 px-2.5 py-2 text-xs")}
              >
                改成不限制
              </button>
            )}
          </div>
        </Field>

        <Field
          id={fieldId("temperature")}
          label={`温度（${form.temperature}）`}
          className="sm:col-span-2"
          hint="0 最确定、2 最发散；笔记问答建议 0.2 ~ 0.5"
        >
          <div className="flex items-center gap-3">
            <input
              id={fieldId("temperature")}
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={form.temperature}
              disabled={submitting}
              onChange={(e) =>
                patchForm({ temperature: clampTemperature(Number(e.target.value)) })
              }
              className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-[#23282f] accent-[#3ddc97] focus:outline-none focus:ring-2 focus:ring-[#3ddc97] disabled:opacity-50"
            />
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              inputMode="decimal"
              value={form.temperature}
              disabled={submitting}
              aria-label="温度数值"
              onChange={(e) =>
                patchForm({ temperature: clampTemperature(Number(e.target.value)) })
              }
              className={cn(INPUT_CLASS, "w-20 shrink-0 font-mono tabular-nums")}
            />
          </div>
        </Field>
      </div>

      {/* 三档价格 */}
      <fieldset className="mt-4 rounded-lg border border-[#23282f] bg-[#12151a] p-3">
        <legend className="px-1 text-xs font-medium text-[var(--nodes-ink-dim)]">
          价格（USD / 100 万 token）
        </legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            id={fieldId("inputPrice")}
            label="输入价格"
            error={errors.inputPrice}
          >
            <input
              id={fieldId("inputPrice")}
              type="number"
              min={0}
              step={0.01}
              inputMode="decimal"
              value={form.inputPrice}
              disabled={submitting}
              placeholder="留空用内置价目表"
              onChange={(e) => {
                patchForm({ inputPrice: e.target.value });
                clearError("inputPrice");
              }}
              className={cn(INPUT_CLASS, "font-mono tabular-nums")}
            />
          </Field>
          <Field
            id={fieldId("cachedInputPrice")}
            label="缓存命中价格"
            error={errors.cachedInputPrice}
          >
            <input
              id={fieldId("cachedInputPrice")}
              type="number"
              min={0}
              step={0.001}
              inputMode="decimal"
              value={form.cachedInputPrice}
              disabled={submitting}
              placeholder="留空用内置价目表"
              onChange={(e) => {
                patchForm({ cachedInputPrice: e.target.value });
                clearError("cachedInputPrice");
              }}
              className={cn(INPUT_CLASS, "font-mono tabular-nums")}
            />
          </Field>
          <Field
            id={fieldId("outputPrice")}
            label="输出价格"
            error={errors.outputPrice}
          >
            <input
              id={fieldId("outputPrice")}
              type="number"
              min={0}
              step={0.01}
              inputMode="decimal"
              value={form.outputPrice}
              disabled={submitting}
              placeholder="留空用内置价目表"
              onChange={(e) => {
                patchForm({ outputPrice: e.target.value });
                clearError("outputPrice");
              }}
              className={cn(INPUT_CLASS, "font-mono tabular-nums")}
            />
          </Field>
        </div>

        <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-[#f5b544]">
          <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          {isEdit
            ? "留空的字段不会提交，后端会保持原有价格不变；想改成 0 请显式填 0。"
            : "留空的字段不会提交，后端会按模型 ID 去内置价目表匹配兜底价。"}
        </p>

        {/* 内置价目表可用模型名（折叠） */}
        <details className="mt-3 rounded-lg border border-[#23282f] bg-[#171b21] px-3 py-2">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-[var(--nodes-ink-dim)] transition-colors hover:text-[var(--nodes-ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3ddc97]">
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            内置价目表可用模型（{priceCatalog.length}）
          </summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {priceCatalog.length === 0 ? (
              <span className="text-[11px] text-[var(--nodes-ink-faint)]">价目表为空</span>
            ) : (
              priceCatalog.map((name) => (
                <span
                  key={name}
                  className="rounded-lg border border-[#23282f] bg-[#0b0d10] px-1.5 py-0.5 font-mono text-[11px] text-[var(--nodes-ink-dim)]"
                >
                  {name}
                </span>
              ))
            )}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--nodes-ink-faint)]">
            按模型 ID 前缀匹配（支持 gpt-4o-2024-11-20 这类带日期的版本号）。
            表内价格会随服务商调价过期，成本核算以这里填写的为准。
          </p>
        </details>
      </fieldset>

      {/* 缓存开关 + 默认模型 */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-[#23282f] bg-[#12151a] p-3">
          <div className="flex items-center gap-2">
            <input
              id={fieldId("supportsPromptCache")}
              type="checkbox"
              checked={form.supportsPromptCache}
              disabled={submitting}
              onChange={(e) => patchForm({ supportsPromptCache: e.target.checked })}
              className="h-4 w-4 shrink-0 cursor-pointer rounded border-[#23282f] bg-[#0b0d10] accent-[#3ddc97] focus:outline-none focus:ring-2 focus:ring-[#3ddc97] disabled:opacity-50"
            />
            <label
              htmlFor={fieldId("supportsPromptCache")}
              className="cursor-pointer text-xs font-medium text-[var(--nodes-ink)]"
            >
              支持 prompt 缓存
            </label>
          </div>
          <p className="mt-2 pl-6 text-[11px] leading-relaxed text-[var(--nodes-ink-faint)]">
            自动前缀缓存的服务商（DeepSeek / OpenAI 等）无需额外配置；Anthropic
            会由应用自动打 cache_control 断点。关闭后该模型不参与缓存优化，成本按未命中计算。
          </p>
        </div>

        <div className="rounded-lg border border-[#23282f] bg-[#12151a] p-3">
          <div className="flex items-center gap-2">
            <input
              id={fieldId("isDefault")}
              type="checkbox"
              checked={form.isDefault}
              disabled={submitting}
              onChange={(e) => patchForm({ isDefault: e.target.checked })}
              className="h-4 w-4 shrink-0 cursor-pointer rounded border-[#23282f] bg-[#0b0d10] accent-[#3ddc97] focus:outline-none focus:ring-2 focus:ring-[#3ddc97] disabled:opacity-50"
            />
            <label
              htmlFor={fieldId("isDefault")}
              className="cursor-pointer text-xs font-medium text-[var(--nodes-ink)]"
            >
              设为默认模型
            </label>
          </div>
          <p className="mt-2 pl-6 text-[11px] leading-relaxed text-[var(--nodes-ink-faint)]">
            新对话默认使用该模型。同一时间只建议保留一个默认；取消勾选后需在别的卡片上重新指定。
          </p>
        </div>
      </div>

      {/* 额外请求参数 */}
      <div className="mt-4">
        <Field
          id={fieldId("extra")}
          label="额外请求参数（JSON，可选）"
          error={errors.extra}
          hint="会原样合并进请求体，例如 top_p、frequency_penalty。留空表示不附加。"
        >
          <textarea
            id={fieldId("extra")}
            rows={4}
            value={form.extraText}
            disabled={submitting}
            spellCheck={false}
            placeholder={'{\n  "top_p": 0.9\n}'}
            onChange={(e) => {
              patchForm({ extraText: e.target.value });
              clearError("extra");
            }}
            aria-invalid={errors.extra !== undefined}
            className={cn(INPUT_CLASS, "resize-y font-mono text-xs")}
          />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-[#23282f] pt-4">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          aria-label="取消并关闭表单"
          className={GHOST_BUTTON_CLASS}
        >
          取消
        </button>
        <button
          type="submit"
          disabled={submitting}
          aria-label={isEdit ? "保存模型修改" : "创建模型配置"}
          aria-busy={submitting}
          className={PRIMARY_BUTTON_CLASS}
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Check className="h-4 w-4" aria-hidden="true" />
          )}
          {submitting ? "保存中…" : isEdit ? "保存修改" : "创建模型"}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* 主面板                                                              */
/* ------------------------------------------------------------------ */

export default function ModelsPanel(): React.JSX.Element {
  const [models, setModels] = useState<ModelView[]>([]);
  const [priceCatalog, setPriceCatalog] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /** 列表级错误（加载 / 删除 / 设为默认） */
  const [listError, setListError] = useState<string | null>(null);
  /** 表单级错误（保存失败） */
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<FormMode>({ kind: "closed" });
  const [submitting, setSubmitting] = useState(false);
  const [cardBusy, setCardBusy] = useState<CardBusy | null>(null);

  const formAnchorRef = useRef<HTMLDivElement | null>(null);

  /** 拉取列表：成功后清掉列表级错误 */
  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await requestJson<ModelsResponse>("/api/models");
      if (!Array.isArray(data.models)) {
        throw new Error("接口返回格式异常：缺少 models 数组");
      }
      setModels(data.models);
      setPriceCatalog(
        Array.isArray(data.priceCatalog) ? data.priceCatalog : [],
      );
      setListError(null);
    } catch (err) {
      setListError(toMessage(err));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
      setLoading(false);
    })();
  }, [load]);

  const handleRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const openCreate = useCallback((): void => {
    setSubmitError(null);
    setFormMode({ kind: "create" });
    // 表单在列表上方，从底部卡片点「编辑」时把表单滚进视野
    requestAnimationFrame(() =>
      formAnchorRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      }),
    );
  }, []);

  const openEdit = useCallback((model: ModelView): void => {
    setSubmitError(null);
    setFormMode({ kind: "edit", model });
    requestAnimationFrame(() =>
      formAnchorRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      }),
    );
  }, []);

  const closeForm = useCallback((): void => {
    setSubmitError(null);
    setFormMode({ kind: "closed" });
  }, []);

  /** 保存：新建 POST / 编辑 PATCH（编辑时 apiKey 空串 = 不修改） */
  const handleSave = useCallback(
    async (payload: ModelPayload): Promise<void> => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        if (formMode.kind === "edit") {
          await requestJson<{ model: ModelView }>("/api/models", {
            method: "PATCH",
            headers: JSON_HEADERS,
            body: JSON.stringify({ id: formMode.model.id, ...payload }),
          });
        } else {
          await requestJson<{ model: ModelView }>("/api/models", {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify(payload),
          });
        }
        // 只有成功才关闭表单，失败时保留用户输入并显示错误条
        setFormMode({ kind: "closed" });
        await load();
      } catch (err) {
        setSubmitError(toMessage(err));
      } finally {
        setSubmitting(false);
      }
    },
    [formMode, load],
  );

  const handleSetDefault = useCallback(
    async (model: ModelView): Promise<void> => {
      setCardBusy({ id: model.id, action: "default" });
      setListError(null);
      try {
        await requestJson<{ model: ModelView }>("/api/models", {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ id: model.id, isDefault: true }),
        });
        await load();
      } catch (err) {
        setListError(toMessage(err));
      } finally {
        setCardBusy(null);
      }
    },
    [load],
  );

  const handleDelete = useCallback(
    async (model: ModelView): Promise<void> => {
      // 需求指定用 window.confirm 做二次确认（不是错误提示，不违反"不用 alert"）
      const confirmed = window.confirm(
        `确定删除模型配置「${model.name}」吗？该操作不可撤销。`,
      );
      if (!confirmed) return;

      setCardBusy({ id: model.id, action: "delete" });
      setListError(null);
      try {
        await requestJson<{ ok: boolean }>(
          `/api/models?id=${encodeURIComponent(model.id)}`,
          { method: "DELETE" },
        );
        // 删掉的正是表单里在编辑的那条 → 顺手关闭表单，避免提交到已不存在的 id
        if (formMode.kind === "edit" && formMode.model.id === model.id) {
          setFormMode({ kind: "closed" });
        }
        await load();
      } catch (err) {
        setListError(toMessage(err));
      } finally {
        setCardBusy(null);
      }
    },
    [formMode, load],
  );

  const isFormOpen = formMode.kind !== "closed";
  const actionsLocked = submitting || cardBusy !== null;

  return (
    <section
      aria-labelledby="models-panel-title"
      className="rounded-xl border border-[#23282f] bg-[#12151a] p-4 text-[var(--nodes-ink)] sm:p-6"
    >
      {/* 头部 */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="models-panel-title"
            className="flex items-center gap-2 text-base font-semibold text-[var(--nodes-ink)]"
          >
            <Cpu className="h-4 w-4 text-[#3ddc97]" aria-hidden="true" />
            模型配置
            <span className="text-xs font-normal text-[var(--nodes-ink-faint)]">
              {loading ? "…" : `${models.length} 个`}
            </span>
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--nodes-ink-dim)]">
            可以配置任意多个模型（OpenAI 兼容 / Anthropic 原生）。API Key
            只写不读，接口仅返回掩码。
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={loading || refreshing || submitting}
            aria-label="刷新模型列表"
            className={GHOST_BUTTON_CLASS}
          >
            <RefreshCw
              className={cn("h-4 w-4", refreshing && "animate-spin")}
              aria-hidden="true"
            />
            刷新
          </button>
          <button
            type="button"
            onClick={openCreate}
            disabled={submitting || isFormOpen}
            aria-label="添加模型"
            className={PRIMARY_BUTTON_CLASS}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            添加模型
          </button>
        </div>
      </header>

      {/* 列表级错误条 */}
      {listError ? (
        <div className="mt-4">
          <NoticeBanner
            message={listError}
            onDismiss={() => setListError(null)}
          />
        </div>
      ) : null}

      {/* 表单锚点：滚动定位用 */}
      <div ref={formAnchorRef} className="scroll-mt-4" />

      {isFormOpen ? (
        <div className="mt-4">
          <ModelForm
            // key 保证切换编辑对象时表单状态被完整重置
            key={formMode.kind === "edit" ? formMode.model.id : "create"}
            initial={formMode.kind === "edit" ? formMode.model : null}
            priceCatalog={priceCatalog}
            submitting={submitting}
            submitError={submitError}
            onSubmit={(payload) => void handleSave(payload)}
            onCancel={closeForm}
          />
        </div>
      ) : null}

      {/* 列表 */}
      <div className="mt-4" aria-busy={loading}>
        {loading ? (
          <>
            <p role="status" className="mb-3 text-xs text-[var(--nodes-ink-dim)]">
              加载中…
            </p>
            <ul className="flex flex-col gap-3">
              <SkeletonCard />
              <SkeletonCard />
            </ul>
          </>
        ) : models.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#23282f] bg-[#171b21] p-8 text-center">
            <KeyRound
              className="mx-auto h-6 w-6 text-[var(--nodes-ink-faint)]"
              aria-hidden="true"
            />
            <p className="mt-3 text-sm font-medium text-[var(--nodes-ink)]">
              还没有配置任何模型
            </p>
            <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-[var(--nodes-ink-dim)]">
              先添加一个模型并设为默认，AI 对话就能用了。推荐从 DeepSeek
              或任意 OpenAI 兼容服务开始。
            </p>
            <button
              type="button"
              onClick={openCreate}
              disabled={submitting || isFormOpen}
              aria-label="添加第一个模型"
              className={cn(PRIMARY_BUTTON_CLASS, "mt-4")}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              添加模型
            </button>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {models.map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                busyAction={
                  cardBusy !== null && cardBusy.id === model.id
                    ? cardBusy.action
                    : null
                }
                actionsDisabled={actionsLocked}
                onEdit={openEdit}
                onSetDefault={(m) => void handleSetDefault(m)}
                onDelete={(m) => void handleDelete(m)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
