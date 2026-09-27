/** 领域类型定义 —— 与 SQLite 表结构一一对应。 */

/*
 * 块类型从**解析模块**导入并再导出，而不是在这里另写一份。
 *
 * 之前两处各写了一份字面量联合，结果是加一个块类型（`diagram`）时
 * 只更新了一处；类型检查只在两处恰巧都被用到的地方报错，
 * 其余地方静默地把新类型当成非法值。单一来源可以根治这类漂移。
 */
import type { BlockKind } from "../blocks/parse-blocks";

export type { BlockKind };

/**
 * 外观设置。
 *
 * 刻意**全部**是可选的调色值，而不是引用设计 token —— 用户改的是自己屏幕上的
 * 观感，不该反过来污染 `globals.css` 里那套供组件使用的 token。
 */
export interface WorkspaceAppearance {
  /** 正文字号，px */
  fontSize: number;
  /** 等宽代码字号，px */
  codeFontSize: number;
  /** 行高倍数 */
  lineHeight: number;
  /** 正文/预览的字体族 CSS 值；空字符串表示用默认 */
  fontFamily: string;
  /** 强调色（十六进制） */
  accent: string;
  /** 主画布背景色（十六进制） */
  canvas: string;
  /** 面板背景色（十六进制） */
  panel: string;
  /**
   * 文字层级色。
   *
   * 分成三档而不是只给一个"文字颜色"，是因为界面里本来就存在三层信息权重
   * （正文 / 次要说明 / 弱化元信息）。只给一个颜色的话，要么全都变同色、
   * 层级塌掉，要么用户得为每一处分别指定 —— 两者都不实用。
   */
  ink: string;
  /** 次要文字色（说明、时间戳） */
  inkDim: string;
  /** 弱化文字色（元信息、占位符） */
  inkFaint: string;
}

/** 外观默认值 —— 与 globals.css 的设计 token 保持一致 */
export const DEFAULT_APPEARANCE: WorkspaceAppearance = {
  fontSize: 13,
  codeFontSize: 13,
  lineHeight: 1.75,
  fontFamily: "",
  accent: "#3ddc97",
  canvas: "#0b0d10",
  panel: "#12151a",
  ink: "#e6e9ee",
  inkDim: "#98a2b3",
  inkFaint: "#6b7280",
};

/** 各数值字段的合法区间 */
const FONT_SIZE_RANGE = { min: 11, max: 22 } as const;
const CODE_FONT_SIZE_RANGE = { min: 11, max: 22 } as const;
const LINE_HEIGHT_RANGE = { min: 1.2, max: 2.4 } as const;

/** `#rgb` 或 `#rrggbb` */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function num(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  if (raw < min || raw > max) return fallback;
  return raw;
}

function color(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const value = raw.trim();
  return HEX_COLOR.test(value) ? value : fallback;
}

/**
 * 容错解析外观设置。
 *
 * 输入可能是 `JSON.parse` 出来的任意值、也可能已经是对象（API 的请求体），
 * 所以这里**逐字段**校验：类型不对、超范围、颜色不合法都单独回退到默认值，
 * 而不是整体丢弃。刻意不抛异常 —— 外观是纯装饰，一个坏字段不该让页面白屏。
 */
export function parseAppearance(raw: unknown): WorkspaceAppearance {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  return {
    fontSize: num(
      source.fontSize,
      DEFAULT_APPEARANCE.fontSize,
      FONT_SIZE_RANGE.min,
      FONT_SIZE_RANGE.max,
    ),
    codeFontSize: num(
      source.codeFontSize,
      DEFAULT_APPEARANCE.codeFontSize,
      CODE_FONT_SIZE_RANGE.min,
      CODE_FONT_SIZE_RANGE.max,
    ),
    lineHeight: num(
      source.lineHeight,
      DEFAULT_APPEARANCE.lineHeight,
      LINE_HEIGHT_RANGE.min,
      LINE_HEIGHT_RANGE.max,
    ),
    // 字体族是自由文本（CSS 值），只要求是字符串
    fontFamily:
      typeof source.fontFamily === "string" ? source.fontFamily : DEFAULT_APPEARANCE.fontFamily,
    accent: color(source.accent, DEFAULT_APPEARANCE.accent),
    canvas: color(source.canvas, DEFAULT_APPEARANCE.canvas),
    panel: color(source.panel, DEFAULT_APPEARANCE.panel),
    // 旧库里没有这三个字段，解析时回退到默认 —— 这正是"新增外观项不需要写迁移"的原因
    ink: color(source.ink, DEFAULT_APPEARANCE.ink),
    inkDim: color(source.inkDim, DEFAULT_APPEARANCE.inkDim),
    inkFaint: color(source.inkFaint, DEFAULT_APPEARANCE.inkFaint),
  };
}

export interface Workspace {
  id: string;
  name: string;
  persona: string;
  conventions: string;
  /** 外观设置，落库为 JSON 字符串 */
  appearance: WorkspaceAppearance;
  createdAt: number;
  updatedAt: number;
}

/**
 * 文档类型。
 *
 * - `doc`    —— 普通文档，有正文（由知识块组成）
 * - `module` —— 模块容器：**本身不写正文**，只用来把同一类知识点挂在一起
 *
 * 为什么要把"分类"做成实体而不是靠标题约定：学习一个领域时，
 * 分类本身就是知识结构（"Unity 我学过哪些"是一个真实的问题），
 * 而且模块是 AI「查漏补缺」的天然作用单位 —— 针对一个模块问
 * "这个方向还缺什么"比针对零散段落问要有意义得多。
 */
export type DocKind = "doc" | "module";

export interface Doc {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  icon: string;
  kind: DocKind;
  sort: number;
  /**
   * 软删除时刻（毫秒）；`null` = 未删。
   *
   * 带上这个字段是为了让调用方能区分"查不到"和"被删了" ——
   * 恢复入口、以及将来给 AI 工具做前置校验都要用到。
   * 常规查询（`listDocs` / `getDoc`）**不会**返回已删的文档。
   */
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Block {
  id: string;
  docId: string;
  /** 文档内的位置，从 0 开始 */
  seq: number;
  kind: BlockKind;
  text: string;
  /** 正文哈希，用于计算 cacheKey 与判断内容是否真的变了 */
  textHash: string;
  /** 稳定排序键 = sha256(textHash + id) 前 16 位；由组装器派生，不落库 */
  cacheKey?: string;
  updatedAt: number;
}

export type ProviderKind = "openai" | "anthropic";

export interface ModelConfig {
  id: string;
  name: string;
  provider: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** 输出上限。`null` = 不限制（请求不带 `max_tokens`，用服务商原生默认值） */
  maxTokens: number | null;
  contextWindow: number;
  supportsPromptCache: boolean;
  inputPrice: number;
  cachedInputPrice: number;
  outputPrice: number;
  /** 额外请求参数，JSON 对象 */
  extra: Record<string, unknown>;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Conversation {
  id: string;
  workspaceId: string;
  title: string;
  modelConfigId: string | null;
  /** 知识块正文预算 */
  sourceBudgetTokens: number;
  createdAt: number;
  updatedAt: number;
}

export type MessageRole = "user" | "assistant" | "system";

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  /** 该消息附带的引用块 id（仅 user 消息有） */
  refBlockIds: string[];
  seq: number;
  createdAt: number;
}

/** 一次模型调用的记录，缓存仪表盘的主表 */
export interface Invocation {
  id: string;
  conversationId: string;
  messageId: string | null;
  modelConfigId: string | null;
  provider: string;
  model: string;
  /** 各层哈希，JSON */
  layerHashes: Record<string, string>;
  prefixHash: string;
  stablePrefixTokens: number;
  predictedCachedTokens: number;
  predictedWriteTokens: number;
  /** 服务商返回的真实用量 */
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  actualUsd: number;
  baselineUsd: number;
  savedUsd: number;
  latencyMs: number;
  /** ok | error | aborted */
  status: string;
  error: string | null;
  /** 请求指纹：provider+model+prefixHash，用于同前缀去重统计 */
  requestFingerprint: string;
  createdAt: number;
}

/** 派生字段：把 cacheKey 挂到 block 上 */
export function withCacheKey(block: Block, compute: (text: string, id: string) => string): Block {
  return { ...block, cacheKey: compute(block.textHash, block.id) };
}
