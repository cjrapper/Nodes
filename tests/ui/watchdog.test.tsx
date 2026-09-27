/**
 * 渲染看门狗的判据测试。
 *
 * ## 为什么单独测这个
 *
 * 看门狗第一版**只看渲染次数**，于是每次 AI 流式回答都会报警 ——
 * SSE 每来一个 token 就 setState 一次，30 次/400ms 是完全健康的节奏，
 * 却被报成"极可能是渲染循环"。
 *
 * 假失败比假通过更危险（AGENTS.md R4.1）：一个总在误报的告警会让人学会
 * 忽略它，于是真正循环时也被一起忽略。所以这个文件的核心是
 * **两条必须同时成立的断言**：
 *
 *  1. 「40 次渲染、间隔 0.2ms」→ **必须报警**（真循环，饿死事件循环）
 *  2. 「35 次渲染、间隔 20ms」→ **必须静默**（正常流式输出）
 *
 * 只写第 1 条是不够的 —— 那正是第一版的错误；第 2 条才是这次修复的内容。
 * 按 R6，第 2 条必须能在旧实现下变红（已手工验证：旧版只看次数，会误报）。
 *
 * ## 为什么注入时钟而不是 sleep
 *
 * 真假循环的区别本质是时间。用真实时间写这个测试只能 sleep，既慢又不稳
 * （机器一卡，20ms 的节奏就变成 200ms，结果随负载变化）。
 * 注入可控时钟后两种场景都是精确构造的，测试瞬间完成且结果确定。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, useState } from "react";
import { act, create } from "react-test-renderer";

import { useRenderWatchdog } from "../../src/lib/ui/hooks.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------------------------------------------ *
 * 装置
 * ------------------------------------------------------------------ */

interface Clock {
  now: () => number;
  advance: (ms: number) => void;
}

function makeClock(start = 1_000_000): Clock {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

/** 拦截 console.error，只留下看门狗发的；同时过滤 react-test-renderer 的弃用警告 */
function captureErrors(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && first.startsWith("[nodes]")) {
      messages.push(first);
      return;
    }
    if (typeof first === "string" && first.includes("react-test-renderer is deprecated")) return;
    original(...args);
  };
  return {
    messages,
    restore: () => {
      console.error = original;
    },
  };
}

/**
 * 挂一个只受控于测试的探针组件，返回"触发一次重渲染"的函数。
 *
 * 用 setState 驱动重渲染 —— 这是测试里唯一能可控地产生"多次渲染"的手段，
 * 也正是真实循环的驱动方式（effect 里 setState）。
 */
function mountProbe(label: string, clock: () => number): () => void {
  let bump: (() => void) | null = null;

  function Probe(): null {
    const [n, setN] = useState(0);
    // 记录 bump 时不读 n：闭包读 n 会让每次渲染产生新的函数，
    // 但这里只用它触发下一次渲染，用函数式更新避免闭包陷阱
    bump = () => setN((v) => v + 1);
    useRenderWatchdog(label, 30, 1000, clock);
    return null;
  }

  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(createElement(Probe));
  });

  const tick = (): void => {
    act(() => bump?.());
  };
  // 本测试只关心"渲染了多少次、间隔多大"，卸载不影响断言；
  // 保留 renderer 引用避免被 GC 提前回收
  assert.ok(renderer);
  return tick;
}

/**
 * 以固定间隔渲染 `times` 次。
 *
 * 每次渲染前把时钟推进 `gapMs` —— 于是"组件渲染了 N 次，每次间隔 Xms"
 * 这个场景是被精确构造出来的，不依赖任何真实时间。
 */
function renderAtInterval(
  label: string,
  times: number,
  gapMs: number,
  clock: Clock,
): void {
  const tick = mountProbe(label, clock.now);
  for (let i = 0; i < times; i += 1) {
    clock.advance(gapMs);
    tick();
  }
}

/* ================================================================== *
 * 判据：真循环必须报
 * ================================================================== */

test("看门狗：同步死循环（同一毫秒内连续渲染）必须报警", () => {
  const captured = captureErrors();
  try {
    /*
     * 间隔 0 —— 也就是"时钟完全没走"。这是同步死循环的**真实形态**：
     * 渲染 → effect 里 setState → 立刻重渲染，全程在同一毫秒内烧 CPU。
     * 不要写成 0.2 之类的亚毫秒值：Date.now() 的分辨率就是 1ms，
     * 小数累加在整数时钟上表现为"好几帧之后才跳 1ms"，
     * 于是中位数被算成 0，反而掩盖了真实节奏（这个坑我踩过一次）。
     */
    renderAtInterval("LoopProbe", 40, 0, makeClock());

    assert.ok(captured.messages.length > 0, "同一毫秒内 40 次渲染必须报警");
    const message = captured.messages[0];
    assert.ok(message.includes("LoopProbe"), `报警要点名组件，实际：${message}`);
    assert.ok(
      message.includes("中位间隔"),
      "报警里必须给出中位间隔 —— 这是判断真假的依据，缺了它用户无法自查",
    );
  } finally {
    captured.restore();
  }
});

/* ================================================================== *
 * 判据：正常流式输出绝不能报（这次修复的内容）
 * ================================================================== */

test("看门狗：流式输出（约 20ms 一次）绝不能报警", () => {
  const captured = captureErrors();
  try {
    // 35 次 / 20ms 间隔 = 700ms 内 35 次 —— 正是当初被误报的那个量级。
    // 旧实现（只看次数）在这里必然报警，所以这条断言就是回归防线。
    renderAtInterval("StreamProbe", 35, 20, makeClock());

    assert.deepEqual(
      captured.messages,
      [],
      `正常的流式渲染不该报警，实际报了：${captured.messages.join(" | ")}`,
    );
  } finally {
    captured.restore();
  }
});

test("看门狗：偶发快帧不会把流式输出误判成循环（用中位数而非最小值）", () => {
  const captured = captureErrors();
  try {
    /*
     * 构造"大多数间隔 20ms，但每 5 次夹一个 0.3ms"的节奏。
     * 用**最小值**当判据会在这里误报；中位数不会。
     * 真实流式输出正是这样：大部分 token 间隔稳定，偶尔两个一起到达。
     */
    const clock = makeClock();
    const tick = mountProbe("JitterProbe", clock.now);
    for (let i = 0; i < 40; i += 1) {
      // 快帧用 0（同一毫秒）而不是 0.3：整数时钟上小数会被吃掉
      clock.advance(i % 5 === 0 ? 0 : 20);
      tick();
    }

    assert.deepEqual(
      captured.messages,
      [],
      `夹带快帧的流式输出不该报警，实际：${captured.messages.join(" | ")}`,
    );
  } finally {
    captured.restore();
  }
});

test("看门狗：渲染次数不够多时不报（阈值仍然生效）", () => {
  const captured = captureErrors();
  try {
    // 间隔极小但次数不到 limit：不该报。否则"连续两帧很快"这种正常抖动
    // 都会触发告警，等于把阈值废掉了。
    renderAtInterval("FewProbe", 20, 0.1, makeClock());
    assert.deepEqual(captured.messages, [], "次数未达阈值不该报警");
  } finally {
    captured.restore();
  }
});

/* ================================================================== *
 * 探针
 * ================================================================== */

test("看门狗：探针给出中位间隔，死循环的数值远小于阈值", () => {
  const captured = captureErrors();
  try {
    renderAtInterval("ProbeRow", 40, 0, makeClock());

    const probe = (
      globalThis as unknown as { __nodesRenderProbe?: () => Record<string, unknown>[] }
    ).__nodesRenderProbe;
    assert.ok(probe, "看门狗应当安装全局探针");

    const rows = probe();
    const row = rows.find((r) => r.组件 === "ProbeRow");
    assert.ok(row, `探针里应当出现 ProbeRow，实际：${JSON.stringify(rows)}`);
    assert.equal(typeof row.中位间隔ms, "number", "探针必须给出中位间隔这一列");
    assert.ok(
      (row.中位间隔ms as number) < 4,
      `死循环的中位间隔应当小于 4ms，实际 ${String(row.中位间隔ms)}`,
    );
    assert.equal(typeof row.渲染次数, "number");
  } finally {
    captured.restore();
  }
});

test("看门狗：探针在中位间隔这一列上同样能区分流式与循环", () => {
  const captured = captureErrors();
  try {
    renderAtInterval("StreamRow", 40, 20, makeClock());

    const rows = (
      globalThis as unknown as { __nodesRenderProbe: () => Record<string, unknown>[] }
    ).__nodesRenderProbe();
    const row = rows.find((r) => r.组件 === "StreamRow");
    assert.ok(row, "探针里应当出现 StreamRow");
    assert.ok(
      (row.中位间隔ms as number) >= 4,
      `流式输出的中位间隔应当明显大于阈值，实际 ${String(row.中位间隔ms)}`,
    );
  } finally {
    captured.restore();
  }
});
