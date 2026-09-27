/**
 * 大纲滚动跟随的渲染循环回归测试。
 *
 * ## 这里守的是什么
 *
 * 接入大纲面板后，开发期的看门狗报了「EditorPanel 在 1000ms 内渲染了 30 次」。
 * 根因是一个只在真实浏览器里成立的回路：
 *
 *   IntersectionObserver 回调 → setActiveBlockId（**哪怕值没变**）
 *   → 组件重渲染 → effect 依赖变化 → 重建 observer → 立即回调 → …
 *
 * React 对同一个值重复 setState 会 bail out 掉子树渲染，所以这条回路不会
 * 报 "Maximum update depth exceeded"，只是安静地把渲染次数堆上去。
 *
 * ## 为什么必须手动触发 observer 回调
 *
 * 测试环境里的 IntersectionObserver 桩**不会自己回调** —— 正是这一点让
 * 这条回路在最初的组件测试里完全隐形。所以这里的桩把回调捕获下来，
 * 由测试**主动、反复**地喂给它同一批条目，模拟真实滚动时的连续通知。
 * 如果实现退回"无条件 setState"，渲染次数会随通知次数线性增长，测试立刻变红。
 *
 * ## 没有 DOM 怎么测
 *
 * react-test-renderer 不提供 DOM，但预览区的滚动跟随需要
 * `container.querySelectorAll("[data-block-key]")`。
 * 这里给"宿主实例的原型"打桩：react-test-renderer 的宿主实例自带 `findAll`，
 * 于是桩函数可以在**自己这棵子树**里找带 `data-block-key` 的节点 ——
 * 语义与真实 DOM 的 querySelectorAll 一致，且不需要为测试改组件。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, Profiler } from "react";
import { act, create } from "react-test-renderer";

/* ---------------- 环境桩 ---------------- */

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// 屏蔽 react-test-renderer 的 deprecation 噪音
const realConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && first.includes("react-test-renderer is deprecated")) return;
  realConsoleError(...args);
};

const listeners = new Map<string, Set<EventListener>>();
globalThis.window = globalThis.window ?? {};
globalThis.window.confirm = () => true;
globalThis.window.addEventListener = ((type: string, handler: EventListener) => {
  const set = listeners.get(type) ?? new Set();
  set.add(handler);
  listeners.set(type, set);
}) as typeof window.addEventListener;
globalThis.window.removeEventListener = ((type: string, handler: EventListener) => {
  listeners.get(type)?.delete(handler);
}) as typeof window.removeEventListener;

const storage = new Map<string, string>();
globalThis.window.localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
  key: () => null,
  get length() {
    return storage.size;
  },
} as unknown as Storage;

/** 会**捕获回调**的 IntersectionObserver 桩，由测试主动触发 */
interface CapturedObserver {
  callback: IntersectionObserverCallback;
  disconnected: boolean;
}

const observers: CapturedObserver[] = [];

class StubIntersectionObserver {
  root = null;
  rootMargin = "";
  thresholds: number[] = [];
  private entry: CapturedObserver;

  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, disconnected: false };
    observers.push(this.entry);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.entry.disconnected = true;
  }
  takeRecords() {
    return [];
  }
}

globalThis.IntersectionObserver = StubIntersectionObserver as unknown as typeof IntersectionObserver;
globalThis.CSS = { escape: (s: string) => s } as unknown as typeof CSS;

/* ---------------- 假预览容器 ----------------
 *
 * 组件通过可选的 `previewContainerOverride` 接收它（生产代码永远不传）。
 * 这样滚动跟随这段逻辑就能在没有 DOM 的测试环境里被真正执行到 ——
 * 而它恰好是渲染循环的发生地。
 */

function makePreviewContainer(blockKeys: string[]) {
  const elements = blockKeys.map((key) => ({
    dataset: { blockKey: key } as DOMStringMap,
    scrollIntoView: () => {},
  }));
  return {
    querySelectorAll: (selector: string) =>
      selector === "[data-block-key]" ? (elements as unknown as Element[]) : [],
    querySelector: (selector: string) => {
      const match = /\[data-block-key="(.+)"\]/.exec(selector);
      return (elements.find((e) => e.dataset.blockKey === match?.[1]) ?? null) as Element | null;
    },
  } as unknown as HTMLElement;
}

/* ---------------- fetch 桩 ---------------- */

const BLOCKS = [
  {
    id: "blk_1",
    seq: 0,
    kind: "heading",
    cacheKey: "aaaaaaaaaaaaaaa1",
    path: "测试文档",
    text: "# 标题",
    refCount: 0,
  },
  {
    id: "blk_2",
    seq: 1,
    kind: "paragraph",
    cacheKey: "aaaaaaaaaaaaaaa2",
    path: "测试文档 › 标题",
    text: "第一段内容。",
    refCount: 0,
  },
];

/*
 * fetch 桩的安装方式。
 *
 * ⚠️ 两个关键点，都是为了"同进程顺序跑多个测试文件"这个前提：
 *
 * 1. **每次挂载时重新安装**，而不是模块加载时装一次。别的测试文件后安装的
 *    处理器会把它挤到链的上游，共享计数器也会被别人的请求搅乱 ——
 *    症状是"单独跑能过、全量跑永远是 0 次"。
 *
 * 2. **只接管本方专用的文档 id**（`OUTLINE_DOC_ID`），其余一律转发。
 *    按 `/api/blocks?docId=` 这种宽泛前缀接管的话，会把 render-loop.test.tsx
 *    的请求也吃掉（它有自己的计数断言），那边的测试就会莫名其妙地挂掉。
 *    用一个不会与别人碰撞的 id，是这里最省事也最可靠的做法。
 */
const OUTLINE_DOC_ID = "doc_outline_loop_test";
let blockFetchCount = 0;

function installFetchStub(): void {
  const fallback = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes(`/api/blocks?docId=${OUTLINE_DOC_ID}`)) {
      return fallback(input, init);
    }
    blockFetchCount += 1;
    return new Response(
      JSON.stringify({
        doc: {
          id: OUTLINE_DOC_ID,
          workspaceId: "ws_t",
          parentId: null,
          title: "测试文档",
          icon: "",
          sort: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        markdown: "# 标题\n\n第一段内容。",
        blockIds: BLOCKS.map((b) => b.id),
        blocks: BLOCKS,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

const { default: EditorPanel } = await import("../../src/components/editor-panel.tsx");

/* ---------------- 测试脚手架 ---------------- */

async function mountEditor() {
  installFetchStub();
  blockFetchCount = 0;
  observers.length = 0;
  let commits = 0;

  const previewContainer = makePreviewContainer(BLOCKS.map((b) => b.id));

  let renderer: ReturnType<typeof create> | null = null;

  await act(async () => {
    renderer = create(
      createElement(
        Profiler,
        { id: "EditorPanel", onRender: () => void (commits += 1) },
        createElement(EditorPanel, {
          docId: OUTLINE_DOC_ID,
          onDocLoaded: () => {},
          onReference: () => {},
          referencedBlockIds: [],
          onSaved: () => {},
          previewContainerOverride: previewContainer,
        }),
      ),
    );
  });

  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /** 手动喂给当前活跃的 observer 一批"可见块"通知 */
  const fire = async (blockKeys: string[]) => {
    const entry = observers.filter((o) => !o.disconnected).at(-1);
    if (!entry) return false;
    const entries = blockKeys.map(
      (key) =>
        ({
          target: { dataset: { blockKey: key } },
          isIntersecting: true,
          intersectionRatio: 1,
        }) as unknown as IntersectionObserverEntry,
    );
    await act(async () => {
      entry.callback(entries, {} as IntersectionObserver);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return true;
  };

  return {
    commits: () => commits,
    fire,
    observerCount: () => observers.length,
    unmount: () => act(() => renderer?.unmount()),
  };
}

/* ---------------- 测试 ---------------- */

test("重复收到同一批可见块通知，不应持续触发重渲染", async () => {
  const h = await mountEditor();
  const baseline = h.commits();

  let fired = 0;
  for (let i = 0; i < 12; i += 1) {
    if (await h.fire(["blk_1", "blk_2"])) fired += 1;
  }

  const added = h.commits() - baseline;
  console.log(
    `[outline] 基线 ${baseline} 次提交，${fired} 次重复通知后新增 ${added} 次，observer 共 ${h.observerCount()} 个`,
  );

  // 桩没被创建说明测试本身失效了，必须大声报出来
  assert.ok(fired > 0, "没有捕获到 IntersectionObserver 回调，测试前提不成立");

  assert.ok(
    added <= 2,
    `${fired} 次重复通知触发了 ${added} 次额外渲染 —— 回调里缺少"值没变就不更新"的判断，存在渲染循环`,
  );
  assert.ok(
    h.observerCount() <= 4,
    `observer 被重建了 ${h.observerCount()} 次，说明 effect 依赖不稳定`,
  );

  h.unmount();
});

test("块真的变化时才重渲染，重复通知被去重", async () => {
  const h = await mountEditor();
  const baseline = h.commits();

  // 依次滚过两个块，中间夹着重复通知
  await h.fire(["blk_1"]);
  await h.fire(["blk_1"]);
  await h.fire(["blk_2"]);
  await h.fire(["blk_2"]);
  await h.fire(["blk_2"]);

  const added = h.commits() - baseline;
  console.log(`[outline] 5 次通知（3 次重复）触发 ${added} 次渲染`);

  // 只有两次真实变化（→blk_1、→blk_2）该引起更新
  assert.ok(added <= 3, `5 次通知（3 次重复）触发了 ${added} 次渲染，去重没有生效`);

  h.unmount();
});

test("挂载阶段只拉取一次文档（没有渲染循环导致的重复请求）", async () => {
  const h = await mountEditor();
  assert.equal(blockFetchCount, 1, `文档被拉了 ${blockFetchCount} 次`);
  h.unmount();
});
