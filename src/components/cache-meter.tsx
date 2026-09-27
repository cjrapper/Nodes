"use client";

/**
 * 缓存仪表：把"这一轮 prompt 会怎么被缓存"变成一眼能看懂的东西。
 *
 * 展示四件事：
 *  1. 分层构成 —— 每一层占多少 token，哪几层与上一轮逐字节相同（会命中）
 *  2. 命中预测 —— 预期读取 / 写入多少，命中率多少
 *  3. 失效根因 —— 相对上一轮是"哪一层变了一句话解释"
 *  4. 断点位置 —— Anthropic 显式缓存的断点打在哪里
 *
 * 为什么值得单独做一个组件：缓存命中率是个反直觉的指标。用户编辑一个
 * 被引用的块，界面上什么都看不出来，账单却会翻十倍。把成本变化可视化
 * 是让"提高缓存命中"这件事真正可操作的前提。
 */

import { AlertTriangle, Info, Layers, Zap } from "lucide-react";
import { useState } from "react";

import { cn, formatPercent, formatTokens } from "@/lib/ui/client";
import type { LayerView, TurnPlanView, TurnResultView } from "@/lib/ui/types";

/** 每层的配色：越靠上越稳定，颜色越"冷"（安全） */
const LAYER_COLOR: Record<string, string> = {
  L0_persona: "#3ddc97",
  L1_workspace: "#4bc4a8",
  L2_source_index: "#6aa8ff",
  L2_source_content: "#8b7bff",
  L3_history: "#f5b544",
  L4_turn: "#f2555a",
};

const VERDICT_META: Record<
  string,
  { label: string; color: string; bg: string; desc: string }
> = {
  hit: {
    label: "预计全命中",
    color: "#3ddc97",
    bg: "rgba(61,220,151,0.12)",
    desc: "所有层与上一轮逐字节一致，输入按缓存价计费。",
  },
  partial: {
    label: "预计部分命中",
    color: "#f5b544",
    bg: "rgba(245,181,68,0.12)",
    desc: "稳定前缀命中折扣价，新增部分按全价计费。",
  },
  cold: {
    label: "本轮需重建缓存",
    color: "#f2555a",
    bg: "rgba(242,85,90,0.12)",
    desc: "没有可复用的前缀，全部输入按全价计费。",
  },
  empty: { label: "无上下文", color: "#6b7280", bg: "rgba(107,114,128,0.12)", desc: "" },
};

function LayerBar({ layers }: { layers: LayerView[] }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const total = layers.reduce((sum, l) => sum + l.tokens, 0) || 1;
  const active = layers.find((l) => l.name === hovered) ?? null;

  return (
    <div>
      <div className="flex h-7 w-full overflow-hidden rounded-md border border-[#23282f] bg-[#0b0d10]">
        {layers.map((layer) => {
          const width = Math.max((layer.tokens / total) * 100, 1.5);
          return (
            <div
              key={layer.name}
              className="group relative h-full cursor-default transition-opacity"
              style={{
                width: `${width}%`,
                background: LAYER_COLOR[layer.name] ?? "#6b7280",
                // 未命中的层用斜纹表达"这段要重新写入"
                opacity: layer.unchanged ? 0.85 : 0.42,
                backgroundImage: layer.unchanged
                  ? undefined
                  : "repeating-linear-gradient(45deg, rgba(0,0,0,0.35) 0 4px, transparent 4px 8px)",
              }}
              onMouseEnter={() => setHovered(layer.name)}
              onMouseLeave={() => setHovered(null)}
              title={`${layer.title} · ${formatTokens(layer.tokens)} token`}
            >
              {layer.hasBreakpoint && (
                <span
                  className="absolute top-0 right-0 h-full w-[3px] bg-white/90"
                  title="Anthropic 缓存断点"
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-2 space-y-1">
        {layers.map((layer) => (
          <div
            key={layer.name}
            className={cn(
              "flex items-center gap-2 rounded px-1.5 py-0.5 text-[11px] transition-colors",
              hovered === layer.name && "bg-[#171b21]",
            )}
            onMouseEnter={() => setHovered(layer.name)}
            onMouseLeave={() => setHovered(null)}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ background: LAYER_COLOR[layer.name] ?? "#6b7280" }}
            />
            <span className="w-[92px] shrink-0 truncate text-[var(--nodes-ink-dim)]">{layer.title}</span>
            <span className="w-[52px] shrink-0 text-right font-mono text-[var(--nodes-ink)]">
              {formatTokens(layer.tokens)}
            </span>
            <span
              className={cn(
                "shrink-0 text-[10px]",
                layer.unchanged ? "text-[#3ddc97]" : "text-[#f5b544]",
              )}
            >
              {layer.unchanged ? "命中" : "变化"}
            </span>
            {layer.hasBreakpoint && (
              <span className="shrink-0 rounded bg-white/10 px-1 text-[9px] text-[var(--nodes-ink)]">
                断点
              </span>
            )}
          </div>
        ))}
      </div>

      {active && (
        <p className="mt-1.5 rounded bg-[#12151a] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--nodes-ink-dim)]">
          {active.hint || "该层的说明见设计文档。"}
        </p>
      )}
    </div>
  );
}

export function CacheMeter({
  plan,
  result,
  streaming,
}: {
  plan: TurnPlanView;
  result?: TurnResultView | null;
  streaming?: boolean;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const meta = VERDICT_META[plan.prediction.verdict] ?? VERDICT_META.empty;

  // 已经拿到真实 usage 时，展示实际值 + 预测准确度；否则只展示预测
  const actual = result?.usage ?? null;
  const hitRate = actual
    ? actual.promptTokens > 0
      ? actual.cachedTokens / actual.promptTokens
      : 0
    : plan.prediction.totalInputTokens > 0
      ? plan.prediction.predictedCachedTokens / plan.prediction.totalInputTokens
      : 0;

  return (
    <div className="rounded-xl border border-[#23282f] bg-[#12151a] p-3">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--nodes-ink)]">
          <Layers size={13} className="text-[#3ddc97]" />
          缓存构成
          {streaming && <span className="nodes-caret text-[#3ddc97]" />}
        </div>
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{ color: meta.color, background: meta.bg }}
        >
          {actual ? "实际" : meta.label}
        </span>
      </div>

      <LayerBar layers={plan.layers} />

      {/* 命中率 + token 拆解 */}
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-[#23282f] pt-2.5">
        <div>
          <div className="text-[10px] text-[var(--nodes-ink-faint)]">{actual ? "实际命中率" : "预测命中率"}</div>
          <div
            className="font-mono text-[15px] font-semibold"
            style={{ color: hitRate > 0.5 ? "#3ddc97" : hitRate > 0 ? "#f5b544" : "#f2555a" }}
          >
            {formatPercent(hitRate)}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-[var(--nodes-ink-faint)]">
            {actual ? "缓存读取" : "预期读取"}
          </div>
          <div className="font-mono text-[15px] font-semibold text-[#3ddc97]">
            {formatTokens(actual ? actual.cachedTokens : plan.prediction.predictedCachedTokens)}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-[var(--nodes-ink-faint)]">
            {actual ? "缓存写入" : "预期写入"}
          </div>
          <div className="font-mono text-[15px] font-semibold text-[#f5b544]">
            {formatTokens(
              actual
                ? actual.cacheWriteTokens ||
                    Math.max(0, actual.promptTokens - actual.cachedTokens)
                : plan.prediction.predictedWriteTokens,
            )}
          </div>
        </div>
      </div>

      {/* 缓存门槛提示：短前缀下缓存根本不生效，必须说清楚 */}
      {plan.prediction.belowCacheFloor && !actual && (
        <p className="mt-2.5 flex items-start gap-1.5 rounded-md bg-[#171b21] px-2 py-1.5 text-[11px] leading-relaxed text-[#f5b544]">
          <Info size={12} className="mt-0.5 shrink-0" />
          <span>
            稳定前缀 {formatTokens(plan.prediction.stablePrefixTokens)} token，低于服务商最小可缓存长度{" "}
            {formatTokens(plan.prediction.cacheFloorTokens)} token —— 本轮缓存不会生效。多 @ 一些知识块或延长对话后才会开始命中。
          </span>
        </p>
      )}

      {/* 失效根因 */}
      {plan.invalidation.reason !== "none" && (
        <p
          className={cn(
            "mt-2.5 flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px] leading-relaxed",
            plan.invalidation.reason === "cold_start" ||
              plan.invalidation.reason === "provider_switched"
              ? "bg-[#171b21] text-[var(--nodes-ink-dim)]"
              : "bg-[#171b21] text-[#f5b544]",
          )}
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>{plan.invalidation.detail}</span>
        </p>
      )}

      {/* 成本 */}
      {result && (
        <div className="mt-2.5 flex items-center justify-between rounded-md bg-[#0b0d10] px-2 py-1.5">
          <div className="flex items-center gap-1 text-[11px] text-[var(--nodes-ink-dim)]">
            <Zap size={11} className="text-[#3ddc97]" />
            本轮花费
          </div>
          <div className="font-mono text-[11px] text-[var(--nodes-ink)]">
            ${result.cost.actualUsd.toFixed(6)}
            <span className="ml-1.5 text-[#3ddc97]">
              {result.cost.savedUsd > 0 ? `省 $${result.cost.savedUsd.toFixed(6)}` : ""}
            </span>
          </div>
        </div>
      )}

      {result && result.predictionAccuracy.actualCachedTokens !== undefined && (
        <p className="mt-1 text-right text-[10px] text-[var(--nodes-ink-faint)]">
          预测 {formatTokens(result.predictionAccuracy.predictedCachedTokens)} · 实际{" "}
          {formatTokens(result.predictionAccuracy.actualCachedTokens)}
          {result.predictionAccuracy.actualCachedTokens > 0 && (
            <span
              className={cn(
                "ml-1",
                result.predictionAccuracy.deltaCached >= 0 ? "text-[#3ddc97]" : "text-[#f5b544]",
              )}
            >
              ({result.predictionAccuracy.deltaCached >= 0 ? "低估" : "高估"}{" "}
              {formatTokens(Math.abs(result.predictionAccuracy.deltaCached))})
            </span>
          )}
        </p>
      )}

      {/* 断点说明 + 折叠的明细 */}
      <button
        type="button"
        onClick={() => setShowDetail((v) => !v)}
        className="mt-2 w-full rounded-md border border-[#23282f] px-2 py-1 text-[10px] text-[var(--nodes-ink-faint)] transition-colors hover:border-[#3ddc97]/40 hover:text-[var(--nodes-ink-dim)]"
      >
        {showDetail ? "收起明细" : "查看断点与知识块明细"}
      </button>

      {showDetail && (
        <div className="mt-2 space-y-2 text-[11px] leading-relaxed text-[var(--nodes-ink-dim)]">
          <p className="rounded bg-[#0b0d10] px-2 py-1.5">{plan.breakpointNote}</p>

          {plan.blockTokens.length > 0 && (
            <div className="rounded bg-[#0b0d10] px-2 py-1.5">
              <div className="mb-1 text-[10px] text-[var(--nodes-ink-faint)]">
                知识块按稳定排序挂载（顺序与 @ 的先后无关）
              </div>
              {plan.blockTokens.map((b) => {
                const omitted = plan.omittedBlockIds.includes(b.id);
                return (
                  <div
                    key={b.id}
                    className={cn(
                      "flex items-center justify-between gap-2",
                      omitted && "text-[var(--nodes-ink-faint)] line-through",
                    )}
                  >
                    <span className="truncate">{b.path}</span>
                    <span className="shrink-0 font-mono">{formatTokens(b.tokens)}</span>
                  </div>
                );
              })}
            </div>
          )}

          {plan.warnings.length > 0 && (
            <ul className="space-y-1">
              {plan.warnings.map((w, i) => (
                <li key={i} className="rounded bg-[#171b21] px-2 py-1.5 text-[#f5b544]">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
