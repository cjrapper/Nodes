/** 前端视图类型 —— 与 API 路由的响应结构一一对应。 */

import type { WorkspaceAppearance } from "@/lib/db/types";

export interface WorkspaceView {
  id: string;
  name: string;
  persona: string;
  conventions: string;
  appearance: WorkspaceAppearance;
  createdAt: number;
  updatedAt: number;
}

export interface DocView {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  icon: string;
  /** 'doc' = 普通文档；'module' = 模块容器（不写正文，只挂载知识点） */
  kind: "doc" | "module";
  sort: number;
  createdAt: number;
  updatedAt: number;
}

export interface DocTreeNode extends DocView {
  children: DocTreeNode[];
}

export interface BlockView {
  id: string;
  seq: number;
  kind: string;
  cacheKey: string;
  path: string;
  text: string;
  refCount: number;
}

export interface ModelView {
  id: string;
  name: string;
  provider: "openai" | "anthropic";
  baseUrl: string;
  model: string;
  apiKeySet: boolean;
  apiKeyHint: string;
  temperature: number;
  /** 输出上限。`null` = 不限制，界面按空值渲染 */
  maxTokens: number | null;
  contextWindow: number;
  supportsPromptCache: boolean;
  inputPrice: number;
  cachedInputPrice: number;
  outputPrice: number;
  extra: Record<string, unknown>;
  isDefault: boolean;
}

export interface ConversationView {
  id: string;
  workspaceId: string;
  title: string;
  modelConfigId: string | null;
  sourceBudgetTokens: number;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
  refCount?: number;
  lastCache?: {
    hitRate: number;
    cachedTokens: number;
    promptTokens: number;
    savedUsd: number;
  } | null;
}

export interface MessageView {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  refBlockIds: string[];
  seq: number;
  createdAt: number;
}

export interface InvocationView {
  id: string;
  conversationId: string;
  provider: string;
  model: string;
  stablePrefixTokens: number;
  predictedCachedTokens: number;
  predictedWriteTokens: number;
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  actualUsd: number;
  baselineUsd: number;
  savedUsd: number;
  latencyMs: number;
  status: string;
  error: string | null;
  createdAt: number;
}

/* ---------------- 缓存计划（对应 /api/chat 的 plan 事件） ---------------- */

export type CacheVerdict = "hit" | "partial" | "cold" | "empty";

export interface LayerView {
  name: string;
  title: string;
  hint: string;
  tokens: number;
  unchanged: boolean;
  hasBreakpoint: boolean;
}

export interface InvalidationView {
  fromLayer: string;
  reason: string;
  detail: string;
}

export interface PredictionView {
  verdict: CacheVerdict;
  predictedCachedTokens: number;
  predictedWriteTokens: number;
  predictedMissTokens: number;
  stablePrefixTokens: number;
  totalInputTokens: number;
  belowCacheFloor: boolean;
  cacheFloorTokens: number;
}

export interface TurnPlanView {
  modelName: string;
  provider: string;
  model: string;
  layers: LayerView[];
  prediction: PredictionView;
  invalidation: InvalidationView;
  breakpointNote: string;
  omittedBlockIds: string[];
  orderedBlockIds: string[];
  blockTokens: { id: string; path: string; tokens: number }[];
  totalTokens: number;
  contextWindow: number;
  sourceBudgetTokens: number;
  warnings: string[];
}

export interface TurnResultView {
  messageId: string;
  invocationId: string;
  content: string;
  reasoning: string;
  usage: {
    promptTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    completionTokens: number;
  };
  cost: {
    actualUsd: number;
    baselineUsd: number;
    savedUsd: number;
    hitRate: number;
    breakEvenReuses: number;
  };
  prediction: PredictionView;
  predictionAccuracy: {
    predictedCachedTokens: number;
    actualCachedTokens: number;
    deltaCached: number;
  };
  latencyMs: number;
  warnings: string[];
  /** 本轮执行过的工具（可能为空）。用户据此知道 AI 动了什么。 */
  tools: {
    id: string;
    name: string;
    summary: string;
    status: string;
    targetDocId: string | null;
  }[];
}

/* ---------------- 聊天事件流 ---------------- */

export type ChatEvent =
  | { type: "start"; conversationId: string; messageId: string; invocationId: string }
  | { type: "plan"; plan: TurnPlanView }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "notice"; message: string }
  /** 模型开始调用一个工具 */
  | { type: "tool_start"; id: string; name: string; argsText: string }
  /** 一个工具执行完毕；`targetDocId` 用于把"已新建《X》"做成可点击的跳转 */
  | {
      type: "tool_result";
      id: string;
      name: string;
      round: number;
      summary: string;
      status: string;
      isError: boolean;
      targetDocId?: string | null;
    }
  | { type: "final"; result: TurnResultView }
  | { type: "error"; message: string };

/* ---------------- 仪表盘 ---------------- */

export interface CacheStatsView {
  invocations: number;
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  actualUsd: number;
  baselineUsd: number;
  savedUsd: number;
  hitRate: number;
  byConversation: {
    conversationId: string;
    title: string;
    invocations: number;
    hitRate: number;
    savedUsd: number;
  }[];
  daily: {
    day: string;
    invocations: number;
    promptTokens: number;
    cachedTokens: number;
    hitRate: number;
    savedUsd: number;
  }[];
}

export interface SearchResultView {
  blockId: string;
  docId: string;
  docTitle: string;
  path: string;
  kind: string;
  cacheKey: string;
  snippet: string;
  refCount: number;
}
