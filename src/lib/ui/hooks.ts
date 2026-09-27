"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * 把回调"钉"成稳定引用，同时始终调用最新的那一份。
 *
 * 为什么需要它：父组件常常传内联箭头函数下来，例如
 *
 *   <EditorPanel onSaved={(impact) => pushToast("warn", ...)} />
 *
 * 这种函数的引用**每次父组件渲染都会变**。如果子组件把它写进
 * `useCallback` / `useEffect` 的依赖数组，就会形成闭环：
 *
 *   子组件 effect 跑 → 调用该回调 → 父组件 setState → 父组件重渲染
 *   → 产生新的函数引用 → 子组件 effect 依赖变化 → effect 再跑 → …
 *
 * 表现是界面疯狂闪烁、终端被同一个请求刷屏（本项目里就是反复拉
 * `/api/blocks`），而且因为每次都真发请求，很难一眼看出是渲染循环。
 *
 * 用法：在子组件里把回调过一遍，然后拿返回值去当依赖 —— 它的引用恒定。
 *
 * 注意 `useRef` 的赋值必须在渲染期完成（而不是放进 effect），
 * 否则"最新回调"会滞后一帧：父组件刚传入的新回调要等到下一次
 * 渲染后才生效，期间调用拿到的还是旧闭包。
 */
export function useStableCallback<Args extends unknown[], R>(
  fn: ((...args: Args) => R) | undefined,
): (...args: Args) => R | undefined {
  const ref = useRef(fn);
  ref.current = fn;

  return useCallback((...args: Args) => ref.current?.(...args), []);
}

/**
 * 开发期用的渲染次数看门狗。
 *
 * 渲染循环极难从症状反推（本项目的症状是"界面闪烁 + 终端被请求刷屏"，
 * 看起来像网络或数据库问题）。在可疑组件里挂上它，一旦短时间内渲染次数
 * 超过阈值就会在控制台指名道姓地报出来，省掉一轮盲猜。
 *
 * ## ⚠️ 只看"次数"会冤枉正常的流式输出（踩过）
 *
 * 第一版只数次数：1 秒内超过 30 次就报警。结果是**每次 AI 流式回答都会报警** ——
 * SSE 每来一个 token 就 `setStreamText` 一次，30 次/400ms（约每 14ms 一次）
 * 是完全健康的节奏，却被报成"极可能是渲染循环"。
 * 假失败比假通过更危险：一个总在误报的告警会让人学会忽略它，
 * 于是真正的循环也被一起忽略（AGENTS.md R4.1 的同一条教训）。
 *
 * ## 判据：渲染**间隔**，不是次数
 *
 * 真假循环有一个物理上无法伪造的区别 —— **是否饿死事件循环**：
 *
 *  | | 每次渲染的间隔 | 原因 |
 *  | --- | --- | --- |
 *  | 同步死循环 | **< 1ms** | JS 线程被占满，没有机会回到事件循环 |
 *  | 流式输出 | 10~50ms | 受网络分片与浏览器节流限制 |
 *  | 用户输入 | 数十~数百 ms | 受人手速限制 |
 *
 * 所以取窗口内相邻渲染间隔的**中位数**：死循环的每个间隔都极小，
 * 中位数必然极小；流式输出里即使偶尔连续两帧很快，中位数依然很大。
 * 用中位数而不是最小值，正是为了不被个别快帧带跑。
 *
 * 两个条件必须**同时**满足才报警：次数够多 **且** 中位间隔够小。
 *
 * ## 全局探针
 *
 * 报警只说明"某个组件渲染太多次"，但要定位是**哪一个**在自激，
 * 光看报警数量不够（多个组件会互相带着重渲染）。
 * 所以每次渲染都往 `window.__nodesRenderProbe` 里记一笔，
 * 浏览器控制台里敲一行就能看到全局排行：
 *
 * ```js
 * copy(window.__nodesRenderProbe())   // 按渲染次数排序的表格，可直接贴出来
 * ```
 *
 * 表格里同时给出 `中位间隔ms` —— 这一列是判断"真循环还是正常流式"的依据，
 * 光看渲染次数分不出来。
 *
 * 只在开发环境记录，生产环境是空操作。
 */

/**
 * 中位间隔低于这个值才认为是"饿死事件循环"的真循环。
 *
 * 4ms 的来源：一次 React 渲染 + 提交在开发模式下通常 0.1~2ms，
 * 所以同步自激的间隔普遍在 1ms 以内（`Date.now()` 的分辨率也是 1ms，
 * 大量样本会直接落在 0）。而任何**受外部节奏驱动**的渲染
 * （网络分片、rAF、定时器）都不可能稳定低于 4ms。
 * 阈值留了 2 倍以上余量，宁可漏报也不误报。
 */
const LOOP_GAP_MS = 4;

/** 保留多少个最近间隔用于算中位数。样本太少时中位数不可靠。 */
const GAP_SAMPLES = 24;

export interface RenderWatchdogStats {
  /** 本窗口内渲染了几次 */
  count: number;
  /** 相邻渲染间隔的中位数（ms）。样本不足时是 null。 */
  medianGapMs: number | null;
}

export function useRenderWatchdog(
  label: string,
  limit = 30,
  windowMs = 1000,
  /**
   * 时钟。**仅供测试注入** —— 真实循环与流式输出的区别本质是时间，
   * 用真实时间写测试就只能 sleep，既慢又不稳；注入一个可控时钟才能
   * 精确构造"40 次同一毫秒"（循环）与"35 次间隔 20ms"（流式）两种场景。
   * 生产代码永远不传。
   */
  clock: () => number = Date.now,
): RenderWatchdogStats {
  /** 本窗口的渲染次数。与下面的间隔样本**分开维护**，理由见下方注释。 */
  const windowCount = useRef(0);
  /** 最近的渲染时间戳，只用于算间隔中位数 */
  const stamps = useRef<number[]>([]);
  const windowStart = useRef(0);
  const nextReport = useRef(limit);
  const stats = useRef<RenderWatchdogStats>({ count: 0, medianGapMs: null });

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;

    const now = clock();

    // ---- 窗口管理：按绝对时间切片，不用"距上次渲染多久" ----
    // 用距上次渲染来切窗口的话，一个稳定的 40ms 节奏永远攒不满窗口，
    // 于是"渲染很多次"这件事根本不会被观察到。
    if (windowStart.current === 0 || now - windowStart.current > windowMs) {
      windowStart.current = now;
      windowCount.current = 0;
      stamps.current = [];
      nextReport.current = limit;
    }
    windowCount.current += 1;
    stamps.current.push(now);

    /*
     * ⚠️ 计数与样本必须分开维护（这里踩过一次）。
     *
     * 第一版把 `count` 直接取自样本数组的长度，而数组又被裁到 GAP_SAMPLES 个 ——
     * 于是 count 永远涨不过 GAP_SAMPLES（24），而阈值是 30，
     * **报警条件永远不可能成立**，看门狗被静默废掉了。
     * 更糟的是它是"假通过"：测试里不报警看起来和"正确判断为不循环"一模一样。
     *
     * 现在：windowCount 是真实的渲染次数（无上限），stamps 只是算中位数的样本。
     */
    if (stamps.current.length > GAP_SAMPLES + 1) {
      stamps.current.splice(0, stamps.current.length - (GAP_SAMPLES + 1));
    }

    const count = windowCount.current;
    const gaps: number[] = [];
    for (let i = 1; i < stamps.current.length; i += 1) {
      gaps.push(stamps.current[i] - stamps.current[i - 1]);
    }
    let medianGapMs: number | null = null;
    if (gaps.length >= 8) {
      const sorted = [...gaps].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      medianGapMs =
        sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    stats.current = { count, medianGapMs };

    // ---- 全局探针 ----
    const probeHost = globalThis as unknown as {
      __nodesRenderCounters?: Map<string, { total: number; last: number[] }>;
    };
    if (!probeHost.__nodesRenderCounters) {
      probeHost.__nodesRenderCounters = new Map();
      (globalThis as unknown as { __nodesRenderProbe?: () => unknown }).__nodesRenderProbe = () => {
        const rows = [...(probeHost.__nodesRenderCounters ?? new Map())].map(([name, stat]) => {
          const recent = stat.last;
          const spanMs =
            recent.length >= 2 ? Math.max(1, recent[recent.length - 1] - recent[0]) : 0;
          const probeGaps: number[] = [];
          for (let i = 1; i < recent.length; i += 1) probeGaps.push(recent[i] - recent[i - 1]);
          const probeMedian = (() => {
            if (probeGaps.length < 3) return null;
            const s = [...probeGaps].sort((a, b) => a - b);
            const m = s.length >> 1;
            return s.length % 2 === 1 ? s[m] : Number(((s[m - 1] + s[m]) / 2).toFixed(1));
          })();
          return {
            组件: name,
            渲染次数: stat.total,
            最近窗口内: recent.length,
            窗口耗时ms: spanMs,
            // 每毫秒渲染次数 —— 大于 0.5 基本就是同步死循环
            每毫秒: spanMs > 0 ? Number((recent.length / spanMs).toFixed(2)) : 0,
            // 判断"真循环还是正常流式"看这一列：< 4ms 才是循环
            中位间隔ms: probeMedian,
          };
        });
        rows.sort((a, b) => b.渲染次数 - a.渲染次数);
        return rows;
      };
    }

    const counters = probeHost.__nodesRenderCounters;
    const stat = counters.get(label) ?? { total: 0, last: [] as number[] };
    stat.total += 1;
    stat.last.push(now);
    // 只保留最近 1 秒的时间戳，够判断"现在还在不在循环"就行
    while (stat.last.length > 0 && now - stat.last[0] > 1000) stat.last.shift();
    counters.set(label, stat);

    // ---- 报警：次数够多 **且** 中位间隔够小 ----
    const isTightLoop = medianGapMs !== null && medianGapMs < LOOP_GAP_MS;
    if (count >= nextReport.current && isTightLoop) {
      const elapsed = Math.max(1, now - windowStart.current);
      console.error(
        `[nodes] 「${label}」在 ${elapsed}ms 内渲染了 ${count} 次` +
          `（中位间隔 ${medianGapMs?.toFixed(2)}ms）—— 极可能是渲染循环。\n` +
          "排查方向一：内联箭头函数被当成了 useCallback / useEffect 的依赖" +
          "（子组件侧用 useStableCallback 包一层即可）。\n" +
          "排查方向二：在 effect 里 setState 时没有先比较新旧值，形成 " +
          "setState → 重渲染 → effect 重建 → setState 的回路。\n" +
          "定位是哪个组件在自激：在控制台执行 copy(window.__nodesRenderProbe())",
      );
      // 继续安排下一次报告，避免"只报一次"让持续存在的循环被忽略
      nextReport.current = count + limit;
    }
  });

  return stats.current;
}
