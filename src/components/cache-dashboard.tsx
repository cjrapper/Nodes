"use client";

/**
 * Prompt 缓存成本仪表盘。
 *
 * 这个应用的核心卖点是"提高大模型 prompt 前缀缓存命中率"，而缓存命中率
 * 是个*看不见*的指标：用户编辑一个被引用的知识块，界面上毫无变化，
 * 账单却可能翻十倍。所以这个页面的唯一任务是——把"命中缓存省下的钱"
 * 变成一排能一眼看懂的、可比较的数字。
 *
 * 三个设计决策值得说明：
 *
 * 1) 命中率配色分三档（>60% 青绿 / 20%~60% 琥珀 / <20% 红）。
 *    单一颜色只能表达"大小"，表达不了"好坏"。命中率不是线性指标：
 *    20% 以下基本等于缓存没生效（前缀反复重建，还要付写入溢价，
 *    很可能比不缓存更贵），20%~60% 是"部分复用"的中间地带，
 *    60% 以上才进入"稳定前缀吃得下大部分输入"的健康区间。
 *    三档正好对应三种该采取的行动：改结构 / 再等等看 / 保持现状。
 *
 * 2) 柱状图手写而不引图表库。整站只装了 lucide-react / clsx /
 *    tailwind-merge，为一个只画"每日命中率"的图引入 recharts 这类库
 *    （+100KB 且带自己的主题系统）不划算；这里的需求也简单到
 *    flex + 高度百分比就够，还能天然继承设计系统的颜色与 font-mono。
 *
 * 3) 零依赖格式化。formatTokens / formatUsd 在本文件内实现，
 *    刻意不从 `@/lib/ui/client` 导入——那个模块与其它面板并行开发，
 *    仪表盘不该因为它的签名变动而挂掉。
 *
 * 另外它同时承载**当前轮次的实时分层明细**（`livePlan` / `liveResult` 两个
 * 可选 props，由 WorkspaceShell 从对话面板收集后传进来）。把这块从对话
 * 面板搬过来，是因为"实时明细"与"历史统计"本来就是同一件事的两个时间尺度。
 */

import { CacheMeter } from "@/components/cache-meter";
import type { TurnPlanView, TurnResultView } from "@/lib/ui/types";

import {
  AlertTriangle,
  ArrowDownRight,
  ChevronDown,
  ChevronRight,
  Clock,
  Info,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------------------------------------------ *
 * 本地格式化
 * ------------------------------------------------------------------ */

/**
 * token 数量：<1000 原样，<1e6 转 K，否则转 M。
 *
 * 为什么不用 toLocaleString 加千分位：token 是量级指标，读者关心的是
 * "5K 还是 50K"，绝对精度反而干扰。K/M 让大数字保持同样的字符宽度，
 * 卡片之间才好横向扫视。
 */
function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return "—";
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

/**
 * 美元金额：<0.0001 用科学计数法，<1 保留 4 位小数，否则 2 位。
 *
 * 为什么要分档：单轮缓存花费经常是 1e-5 量级，用 toFixed(2) 会全部
 * 显示成 $0.00，用户会以为"没花钱"而忽略掉真正的问题；而总额又不需要
 * 小数点后六位。分档让每个量级都有可读的精度。
 */
function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  const sign = usd < 0 ? "-" : "";
  const abs = Math.abs(usd);
  if (abs === 0) return "$0";
  if (abs < 0.0001) return `${sign}$${abs.toExponential(2)}`;
  if (abs < 1) return `${sign}$${abs.toFixed(4)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

/** 比率 → 百分比文本。0~1 之外的脏数据按 0 处理，不让 UI 出现 NaN% */
function formatPercent(ratio: number, digits = 0): string {
  if (!Number.isFinite(ratio)) return "—";
  const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  return `${(clamped * 100).toFixed(digits)}%`;
}

/** "2025-01-15" → "01-15"。日趋势的 X 轴只放月-日，年份太占地方。 */
function shortDay(day: string): string {
  const parts = day.split("-");
  if (parts.length >= 3) return `${parts[1]}-${parts[2]}`;
  return day;
}

/** Unix 毫秒 → "MM-DD HH:mm"，用于逐轮明细表，同时兼容秒级时间戳 */
function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const normalized = ms < 1e12 ? ms * 1000 : ms;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/* ------------------------------------------------------------------ *
 * 类型（本地声明，不依赖并行开发的 @/lib/ui 模块）
 * ------------------------------------------------------------------ */

type RangeKey = "24h" | "7d" | "30d" | "all";

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "24h", label: "24 小时" },
  { key: "7d", label: "7 天" },
  { key: "30d", label: "30 天" },
  { key: "all", label: "全部" },
];

interface DailyPoint {
  day: string;
  invocations: number;
  promptTokens: number;
  cachedTokens: number;
  hitRate: number;
  savedUsd: number;
}

interface ConversationStat {
  conversationId: string;
  title: string;
  invocations: number;
  hitRate: number;
  savedUsd: number;
}

interface CacheStats {
  invocations: number;
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  actualUsd: number;
  baselineUsd: number;
  savedUsd: number;
  hitRate: number;
  byConversation: ConversationStat[];
  daily: DailyPoint[];
}

interface InvocationView {
  id: string;
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

interface StatsResponse {
  range: string;
  stats: CacheStats;
  recentInvocations: InvocationView[];
}

/* ------------------------------------------------------------------ *
 * 配色
 * ------------------------------------------------------------------ */

const HIT_GOOD = "#3ddc97";
const HIT_MID = "#f5b544";
const HIT_BAD = "#f2555a";

/**
 * 命中率 → 颜色（见文件头决策 1）。
 * 60% 与 20% 这两条分界线是"该不该动手改 prompt 结构"的行动阈值。
 */
function hitColor(rate: number): string {
  if (!Number.isFinite(rate)) return "#6b7280";
  if (rate > 0.6) return HIT_GOOD;
  if (rate >= 0.2) return HIT_MID;
  return HIT_BAD;
}

/** 命中率的定性标签，配合颜色一起读，避免"颜色即全部信息"的无障碍问题 */
function hitLabel(rate: number): string {
  if (!Number.isFinite(rate)) return "无数据";
  if (rate > 0.6) return "稳定复用";
  if (rate >= 0.2) return "部分复用";
  return "缓存几乎未生效";
}

/* ------------------------------------------------------------------ *
 * 小组件
 * ------------------------------------------------------------------ */

/** 顶部大数字卡。value 用 font-mono，保证四个数字的字符栅格对齐 */
function MetricCard({
  label,
  value,
  valueColor,
  hint,
  icon,
}: {
  label: string;
  value: string;
  valueColor?: string;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[#23282f] bg-[#12151a] p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--nodes-ink-dim)]">
        {icon}
        {label}
      </div>
      <div
        className="mt-1.5 font-mono text-[20px] leading-tight font-semibold"
        style={{ color: valueColor ?? "#e6e9ee" }}
      >
        {value}
      </div>
      <div className="mt-1 min-h-[14px] text-[10px] text-[var(--nodes-ink-faint)]">{hint}</div>
    </div>
  );
}

/** 细进度条：会话排行里的命中率可视化，宽度即比率 */
function ThinBar({ ratio, color }: { ratio: number; color: string }) {
  const safe = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0;
  return (
    <div className="h-[3px] w-full overflow-hidden rounded-full bg-[#23282f]">
      <div
        className="h-full rounded-full"
        style={{ width: `${safe * 100}%`, background: color }}
      />
    </div>
  );
}

/**
 * 实际花费 vs 不缓存花费的对比条。
 * 两根条共用一个比例尺（以 baseline 为 100%），所以"实际条有多短"
 * 本身就是节省幅度的视觉表达，不需要读者自己算百分比。
 */
function CostComparison({ actualUsd, baselineUsd }: { actualUsd: number; baselineUsd: number }) {
  const actual = Number.isFinite(actualUsd) ? Math.max(actualUsd, 0) : 0;
  const baseline = Number.isFinite(baselineUsd) ? Math.max(baselineUsd, 0) : 0;
  const scale = baseline > 0 ? baseline : Math.max(actual, 1e-9);
  // 条宽至少留 1.5%，否则"几乎不花钱"会被画成一条看不见的线
  const actualPct = Math.max((actual / scale) * 100, 1.5);
  const baselinePct = Math.max((baseline / scale) * 100, 1.5);
  const savedRatio = baseline > 0 ? (baseline - actual) / baseline : 0;

  return (
    <section className="rounded-xl border border-[#23282f] bg-[#12151a] p-3">
      <div className="mb-2.5 flex items-center gap-1.5 text-[12px] font-medium text-[var(--nodes-ink)]">
        <ArrowDownRight size={13} className="text-[#3ddc97]" />
        不缓存会花多少
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="w-[68px] shrink-0 text-[11px] text-[var(--nodes-ink-dim)]">实际花费</span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-[#0b0d10]">
            <div
              className="h-full rounded"
              style={{ width: `${actualPct}%`, background: HIT_GOOD, opacity: 0.85 }}
              title={`实际花费 ${formatUsd(actual)}`}
            />
          </div>
          <span className="w-[104px] shrink-0 text-right font-mono text-[11px] text-[var(--nodes-ink)]">
            {formatUsd(actual)}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="w-[68px] shrink-0 text-[11px] text-[var(--nodes-ink-dim)]">不缓存需</span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-[#0b0d10]">
            <div
              className="h-full rounded"
              style={{ width: `${baselinePct}%`, background: "#f2555a", opacity: 0.55 }}
              title={`完全不命中的花费 ${formatUsd(baseline)}`}
            />
          </div>
          <span className="w-[104px] shrink-0 text-right font-mono text-[11px] text-[var(--nodes-ink-dim)]">
            {formatUsd(baseline)}
          </span>
        </div>
      </div>

      <p className="mt-2.5 font-mono text-[11px] text-[var(--nodes-ink-dim)]">
        实际 <span className="text-[var(--nodes-ink)]">{formatUsd(actual)}</span>
        <span className="mx-1.5 text-[var(--nodes-ink-faint)]">·</span>
        不缓存需 <span className="text-[var(--nodes-ink)]">{formatUsd(baseline)}</span>
        <span className="mx-1.5 text-[var(--nodes-ink-faint)]">·</span>
        <span style={{ color: savedRatio > 0 ? HIT_GOOD : HIT_BAD }}>
          省下 {formatPercent(savedRatio)}
        </span>
      </p>
    </section>
  );
}

/**
 * 每日命中率趋势（纯 div 手写，见文件头决策 2）。
 *
 * 高度按"数据中的最高命中率"归一到 100%：命中率的绝对值没有形态重要，
 * 用户要看的是"哪一天掉下去了"。零点保留 2% 高度，否则那天的柱子消失，
 * 读者分不清"命中率为 0"和"这天没有数据"。
 */
function DailyTrend({ daily }: { daily: DailyPoint[] }) {
  const maxRate = daily.reduce((max, d) => Math.max(max, Number.isFinite(d.hitRate) ? d.hitRate : 0), 0);
  const scale = maxRate > 0 ? maxRate : 1;

  if (daily.length === 0) {
    return (
      <section className="rounded-xl border border-[#23282f] bg-[#12151a] p-3">
        <div className="mb-2.5 text-[12px] font-medium text-[var(--nodes-ink)]">每日命中率趋势</div>
        <p className="py-6 text-center text-[11px] text-[var(--nodes-ink-faint)]">
          这个时间范围内还没有按天数据。
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-[#23282f] bg-[#12151a] p-3">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="text-[12px] font-medium text-[var(--nodes-ink)]">每日命中率趋势</div>
        <div className="text-[10px] text-[var(--nodes-ink-faint)]">
          峰值 {formatPercent(maxRate, 0)} · 共 {daily.length} 天
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="flex min-w-full items-stretch gap-1" style={{ minWidth: daily.length * 26 }}>
          {daily.map((d) => {
            const rate = Number.isFinite(d.hitRate) ? Math.min(Math.max(d.hitRate, 0), 1) : 0;
            const heightPct = Math.max((rate / scale) * 100, 2);
            const from = d.promptTokens - d.cachedTokens;
            return (
              <div key={d.day} className="flex min-w-[22px] flex-1 flex-col items-center">
                <div
                  className="group flex h-[140px] w-full cursor-default items-end"
                  title={
                    `${d.day}\n` +
                    `命中率：${formatPercent(rate, 1)}\n` +
                    `输入 token：${formatTokens(d.promptTokens)}（命中 ${formatTokens(d.cachedTokens)}）\n` +
                    `未命中 token：${formatTokens(from)}\n` +
                    `调用轮次：${d.invocations}\n` +
                    `节省：${formatUsd(d.savedUsd)}`
                  }
                >
                  <div
                    className="w-full rounded-t-[3px] opacity-70 transition-opacity group-hover:opacity-100"
                    style={{
                      height: `${heightPct}%`,
                      background: hitColor(rate),
                    }}
                  />
                </div>
                <div className="mt-1 w-full text-center font-mono text-[9px] whitespace-nowrap text-[var(--nodes-ink-faint)]">
                  {shortDay(d.day)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** 逐轮明细表的单元格。数字列一律 font-mono，右对齐方便对比量级 */
function Num({
  children,
  color,
  title,
}: {
  children: React.ReactNode;
  color?: string;
  title?: string;
}) {
  return (
    <td
      className="px-2 py-1 text-right font-mono whitespace-nowrap"
      style={{ color: color ?? "#e6e9ee" }}
      title={title}
    >
      {children}
    </td>
  );
}

/**
 * 单轮调用明细。
 *
 * 注意口径：顶部汇总卡的 SQL 只统计 status='ok' 的轮次，所以这里算
 * 会话合计时同样过滤掉 error，否则"明细合计"和"卡片刻度"对不上。
 * error 行本身仍然显示（排查问题正需要看到它），用红色左边框标记。
 */
function InvocationTable({ rows }: { rows: InvocationView[] }) {
  const okRows = useMemo(() => rows.filter((r) => r.status === "ok"), [rows]);
  const totalSaved = okRows.reduce((sum, r) => sum + r.savedUsd, 0);
  const totalActual = okRows.reduce((sum, r) => sum + r.actualUsd, 0);
  const errorCount = rows.length - okRows.length;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[840px] border-collapse text-[11px]">
        <caption className="sr-only">
          所选会话的逐轮调用明细：时间、模型、预测命中、实际命中、命中率、输入输出
          token、本轮花费、节省与耗时
        </caption>
        <thead>
          <tr className="text-[10px] text-[var(--nodes-ink-faint)]">
            <th scope="col" className="px-2 py-1 text-left font-normal">
              时间
            </th>
            <th scope="col" className="px-2 py-1 text-left font-normal">
              模型
            </th>
            <th scope="col" className="px-2 py-1 text-right font-normal">
              预测命中
            </th>
            <th scope="col" className="px-2 py-1 text-right font-normal">
              实际命中
            </th>
            <th scope="col" className="px-2 py-1 text-right font-normal">
              命中率
            </th>
            <th scope="col" className="px-2 py-1 text-right font-normal">
              输入 / 输出
            </th>
            <th scope="col" className="px-2 py-1 text-right font-normal">
              本轮花费
            </th>
            <th scope="col" className="px-2 py-1 text-right font-normal">
              节省
            </th>
            <th scope="col" className="px-2 py-1 text-right font-normal">
              耗时
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} className="px-2 py-4 text-center text-[11px] text-[var(--nodes-ink-faint)]">
                这个会话在该时间范围内没有调用记录。
              </td>
            </tr>
          )}
          {rows.map((row) => {
            const isError = row.status !== "ok";
            const rate =
              row.promptTokens > 0 ? Math.min(Math.max(row.cachedTokens / row.promptTokens, 0), 1) : 0;
            return (
              <tr
                key={row.id}
                className="border-t border-[#23282f] border-l-2 align-middle"
                style={{
                  borderLeftColor: isError ? HIT_BAD : "transparent",
                  background: isError ? "rgba(242,85,90,0.06)" : undefined,
                }}
                title={isError ? (row.error ?? "调用失败") : undefined}
              >
                <td className="px-2 py-1 font-mono whitespace-nowrap text-[var(--nodes-ink-dim)]" title={row.id}>
                  {formatTimestamp(row.createdAt)}
                </td>
                <td className="max-w-[180px] truncate px-2 py-1 text-[var(--nodes-ink)]" title={row.model}>
                  {row.model}
                  {isError && (
                    <span className="ml-1.5 rounded bg-[#f2555a]/15 px-1 text-[9px] text-[#f2555a]">
                      error
                    </span>
                  )}
                </td>
                <Num color="#98a2b3" title="本轮开始时预测会命中的 token">
                  {formatTokens(row.predictedCachedTokens)}
                </Num>
                <Num color={row.cachedTokens > 0 ? HIT_GOOD : "#6b7280"}>
                  {formatTokens(row.cachedTokens)}
                </Num>
                <Num color={isError ? "#6b7280" : hitColor(rate)}>{formatPercent(rate)}</Num>
                <Num color="#98a2b3" title={`输入 ${row.promptTokens} · 输出 ${row.completionTokens}`}>
                  {formatTokens(row.promptTokens)} / {formatTokens(row.completionTokens)}
                </Num>
                <Num>{formatUsd(row.actualUsd)}</Num>
                <Num color={row.savedUsd > 0 ? HIT_GOOD : "#6b7280"}>{formatUsd(row.savedUsd)}</Num>
                <Num color="#98a2b3" title={`${row.latencyMs} ms`}>
                  {formatLatency(row.latencyMs)}
                </Num>
              </tr>
            );
          })}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr className="border-t border-[#23282f] text-[10px] text-[var(--nodes-ink-faint)]">
              <td className="px-2 py-1" colSpan={6}>
                共 {rows.length} 轮
                {errorCount > 0 && (
                  <span className="ml-1.5 text-[#f2555a]">（{errorCount} 轮失败，不计入合计）</span>
                )}
              </td>
              <td className="px-2 py-1 text-right font-mono">{formatUsd(totalActual)}</td>
              <td className="px-2 py-1 text-right font-mono" style={{ color: HIT_GOOD }}>
                {formatUsd(totalSaved)}
              </td>
              <td className="px-2 py-1" />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 主组件
 * ------------------------------------------------------------------ */

interface CacheDashboardProps {
  /** 当前对话最近一轮的缓存组装计划（来自 /api/preview 或 chat 的 plan 事件） */
  livePlan?: TurnPlanView | null;
  /** 该轮的结算结果（有则为实际值，无则只显示预测） */
  liveResult?: TurnResultView | null;
  /** 是否正在流式输出 */
  streaming?: boolean;
}

export default function CacheDashboard({
  livePlan = null,
  liveResult = null,
  streaming = false,
}: CacheDashboardProps = {}): React.JSX.Element {
  const [range, setRange] = useState<RangeKey>("7d");
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** 展开中的会话 id（一次只看一个，避免同时拉多份明细） */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 明细缓存：按会话 id 存，并记住它属于哪个时间范围 */
  const [details, setDetails] = useState<
    Record<string, { range: RangeKey; rows: InvocationView[] }>
  >({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  // 竞态防护：快速连点时间范围时，只接受最后一次请求的结果
  const listSeqRef = useRef(0);
  const detailSeqRef = useRef(0);

  const loadStats = useCallback(async (nextRange: RangeKey) => {
    const seq = ++listSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/stats?range=${encodeURIComponent(nextRange)}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        // 后端约定失败时返回 { error: string }
        let message = `请求失败（HTTP ${res.status}）`;
        try {
          const parsed = (await res.json()) as { error?: unknown };
          if (parsed?.error) message = String(parsed.error);
        } catch {
          /* 响应体不是 JSON，保留默认文案 */
        }
        throw new Error(message);
      }
      const json = (await res.json()) as StatsResponse;
      if (seq !== listSeqRef.current) return; // 已有更新的请求，丢弃这次结果
      setData(json);
    } catch (err) {
      if (seq !== listSeqRef.current) return;
      setError(err instanceof Error ? err.message : "加载缓存统计失败");
    } finally {
      if (seq === listSeqRef.current) setLoading(false);
    }
  }, []);

  // 切换时间范围 → 重新请求。数据不清空，避免每次切换都闪一下白屏。
  useEffect(() => {
    void loadStats(range);
  }, [range, loadStats]);

  /**
   * 点击会话标题：展开时按需拉取该会话最近 40 条调用记录。
   *
   * force 供错误条上的"重试"使用：重试时该行本来就是展开状态，
   * 走普通路径会被当成"再点一次收起"而直接折叠，看起来像按钮失灵。
   */
  const toggleConversation = useCallback(
    async (conversationId: string, force = false) => {
      setDetailError(null);
      if (!force && expandedId === conversationId) {
        setExpandedId(null);
        return;
      }
      setExpandedId(conversationId);

      // 同一时间范围内已有缓存就直接用，不重复请求；重试则强制重取
      const cached = details[conversationId];
      if (!force && cached && cached.range === range) return;

      const seq = ++detailSeqRef.current;
      setDetailLoading(conversationId);
      try {
        const res = await fetch(
          `/api/stats?range=${encodeURIComponent(range)}&conversationId=${encodeURIComponent(conversationId)}`,
          { headers: { Accept: "application/json" } },
        );
        if (!res.ok) throw new Error(`明细请求失败（HTTP ${res.status}）`);
        const json = (await res.json()) as StatsResponse;
        if (seq !== detailSeqRef.current) return;
        setDetails((prev) => ({
          ...prev,
          [conversationId]: { range, rows: json.recentInvocations ?? [] },
        }));
      } catch (err) {
        if (seq !== detailSeqRef.current) return;
        setDetailError(err instanceof Error ? err.message : "加载逐轮明细失败");
      } finally {
        if (seq === detailSeqRef.current) setDetailLoading(null);
      }
    },
    [details, expandedId, range],
  );

  const stats = data?.stats ?? null;
  const isEmpty = !loading && stats !== null && stats.invocations === 0;

  return (
    <div className="space-y-3 p-3 text-[12px] text-[var(--nodes-ink)]">
      {/*
        当前轮次的实时分层明细。
        
        原先这块挂在对话面板右侧，占掉一大条竖向空间，而它其实是"想知道
        钱花在哪"时才看的东西 —— 放在缓存页里，既让对话区回归干净的聊天
        界面，也让"实时明细"和"历史统计"这两个同类信息待在一起。
      */}
      {livePlan && (
        <section className="space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--nodes-ink-faint)]">
            <span className="font-medium tracking-wider uppercase">本轮实时明细</span>
            <span className="text-[#23282f]">·</span>
            <span>来自当前对话的缓存组装结果</span>
          </div>
          <CacheMeter plan={livePlan} result={liveResult} streaming={streaming} />
        </section>
      )}

      {/* 标题 + 时间范围切换 */}
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Sparkles size={14} className="text-[#3ddc97]" />
          <h2 className="text-[13px] font-semibold">
            {livePlan ? "历史累计" : "缓存成本仪表盘"}
          </h2>
          {loading && <Loader2 size={12} className="animate-spin text-[var(--nodes-ink-faint)]" />}
        </div>

        <div className="flex items-center gap-1" role="group" aria-label="时间范围">
          {RANGES.map((r) => {
            const active = r.key === range;
            return (
              <button
                key={r.key}
                type="button"
                aria-pressed={active}
                onClick={() => setRange(r.key)}
                className={
                  "rounded-md border px-2 py-1 text-[11px] transition-colors " +
                  (active
                    ? "border-[#3ddc97]/40 bg-[#3ddc97]/10 text-[#3ddc97]"
                    : "border-[#23282f] text-[var(--nodes-ink-dim)] hover:bg-[#171b21] hover:text-[var(--nodes-ink)]")
                }
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </header>

      {/* 错误条：页面内提示 + 重试，不弹窗打断阅读 */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-[#f2555a]/40 bg-[#f2555a]/10 px-3 py-2 text-[11px]"
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[#f2555a]" />
          <div className="flex-1 leading-relaxed text-[var(--nodes-ink)]">
            <div className="font-medium text-[#f2555a]">加载统计失败</div>
            <div className="text-[var(--nodes-ink-dim)]">{error}</div>
          </div>
          <button
            type="button"
            onClick={() => void loadStats(range)}
            className="flex shrink-0 items-center gap-1 rounded-md border border-[#23282f] px-2 py-1 text-[11px] text-[var(--nodes-ink-dim)] transition-colors hover:bg-[#171b21] hover:text-[var(--nodes-ink)]"
          >
            <RefreshCw size={11} />
            重试
          </button>
        </div>
      )}

      {/* 首次加载（还没有任何数据可展示时）的骨架 */}
      {loading && !stats && !error && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="nodes-shimmer h-[76px] rounded-xl border border-[#23282f] bg-[#12151a]"
              />
            ))}
          </div>
          <div className="nodes-shimmer h-[120px] rounded-xl border border-[#23282f] bg-[#12151a]" />
        </div>
      )}

      {/* 空态：没有调用记录时不堆一排 0，而是告诉用户下一步该做什么 */}
      {isEmpty && stats && (
        <div className="rounded-xl border border-[#23282f] bg-[#12151a] p-6 text-center">
          <Info size={18} className="mx-auto text-[var(--nodes-ink-faint)]" />
          <p className="mx-auto mt-2 max-w-[440px] text-[12px] leading-relaxed text-[var(--nodes-ink-dim)]">
            还没有调用记录。到对话里挂载几个知识块并提问，这里就会显示缓存命中与节省情况。
            提示：前缀越长、越稳定，命中率越高。
          </p>
        </div>
      )}

      {/* 有数据（或正在刷新旧数据）时的主体 */}
      {stats && !isEmpty && (
        <div
          className={"space-y-3 transition-opacity " + (loading ? "opacity-60" : "opacity-100")}
          aria-busy={loading}
        >
          {/* 1. 四个关键指标 */}
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <MetricCard
              label="缓存命中率"
              value={formatPercent(stats.hitRate, 1)}
              valueColor={hitColor(stats.hitRate)}
              hint={
                <span style={{ color: hitColor(stats.hitRate) }}>
                  {hitLabel(stats.hitRate)} · 命中 {formatTokens(stats.cachedTokens)}
                </span>
              }
            />
            <MetricCard
              label="省下的钱"
              value={formatUsd(stats.savedUsd)}
              valueColor={stats.savedUsd > 0 ? HIT_GOOD : "#e6e9ee"}
              hint={`原价 ${formatUsd(stats.baselineUsd)} → 实付 ${formatUsd(stats.actualUsd)}`}
            />
            <MetricCard
              label="输入 token 总量"
              value={formatTokens(stats.promptTokens)}
              hint={`其中缓存命中 ${formatTokens(stats.cachedTokens)}`}
            />
            <MetricCard
              label="调用轮次"
              value={String(stats.invocations)}
              hint={`输出 token ${formatTokens(stats.completionTokens)}`}
            />
          </div>

          {/* 2. 实际 vs 不缓存 */}
          <CostComparison actualUsd={stats.actualUsd} baselineUsd={stats.baselineUsd} />

          {/* 3. 每日趋势 */}
          <DailyTrend daily={stats.daily ?? []} />

          {/* 4. 会话排行 */}
          <section className="rounded-xl border border-[#23282f] bg-[#12151a] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[12px] font-medium text-[var(--nodes-ink)]">按会话排行</div>
              <div className="text-[10px] text-[var(--nodes-ink-faint)]">按节省金额降序 · 点击标题看逐轮明细</div>
            </div>

            {stats.byConversation.length === 0 ? (
              <p className="py-4 text-center text-[11px] text-[var(--nodes-ink-faint)]">该范围内没有会话数据。</p>
            ) : (
              <ul className="space-y-0.5">
                {stats.byConversation.map((conv) => {
                  const isOpen = expandedId === conv.conversationId;
                  const isLoadingDetail = detailLoading === conv.conversationId;
                  const detail = details[conv.conversationId];
                  const rows = detail && detail.range === range ? detail.rows : [];
                  return (
                    <li key={conv.conversationId} className="rounded-md">
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() => void toggleConversation(conv.conversationId)}
                        className={
                          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors " +
                          (isOpen ? "bg-[#171b21]" : "hover:bg-[#171b21]")
                        }
                      >
                        <span className="shrink-0 text-[var(--nodes-ink-faint)]">
                          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--nodes-ink)]">
                          {conv.title || "未命名会话"}
                        </span>
                        <span className="w-[52px] shrink-0 text-right font-mono text-[11px] text-[var(--nodes-ink-dim)]">
                          {conv.invocations} 轮
                        </span>
                        <span className="flex w-[86px] shrink-0 items-center gap-1.5">
                          <ThinBar ratio={conv.hitRate} color={hitColor(conv.hitRate)} />
                          <span
                            className="w-[34px] shrink-0 text-right font-mono text-[11px]"
                            style={{ color: hitColor(conv.hitRate) }}
                          >
                            {formatPercent(conv.hitRate)}
                          </span>
                        </span>
                        <span
                          className="w-[84px] shrink-0 text-right font-mono text-[11px]"
                          style={{ color: conv.savedUsd > 0 ? HIT_GOOD : "#6b7280" }}
                        >
                          {formatUsd(conv.savedUsd)}
                        </span>
                      </button>

                      {isOpen && (
                        <div className="mt-1 mb-1.5 border-l-2 border-[#23282f] pl-2">
                          {isLoadingDetail ? (
                            <div className="flex items-center gap-1.5 px-2 py-3 text-[11px] text-[var(--nodes-ink-faint)]">
                              <Loader2 size={12} className="animate-spin" />
                              正在加载逐轮明细…
                            </div>
                          ) : detailError ? (
                            <div className="flex items-center gap-2 px-2 py-2 text-[11px] text-[#f2555a]">
                              <AlertTriangle size={12} />
                              {detailError}
                              <button
                                type="button"
                                onClick={() => void toggleConversation(conv.conversationId, true)}
                                className="rounded border border-[#23282f] px-1.5 py-0.5 text-[10px] text-[var(--nodes-ink-dim)] hover:text-[var(--nodes-ink)]"
                              >
                                重试
                              </button>
                            </div>
                          ) : (
                            <InvocationTable rows={rows} />
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}

      {/* 5. 脚注：解释缓存为什么会有"重建"这件事 */}
      <p className="flex items-start gap-1.5 px-0.5 text-[10px] leading-relaxed text-[var(--nodes-ink-faint)]">
        <Clock size={11} className="mt-0.5 shrink-0" />
        <span>
          缓存只对相同前缀生效：命中部分按折扣价计费。编辑被引用的知识块、切换模型、修改人设都会让缓存重建。
        </span>
      </p>
    </div>
  );
}
