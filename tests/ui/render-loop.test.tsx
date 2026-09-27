/**
 * 渲染循环回归测试。
 *
 * ## 为什么需要这个文件
 *
 * 曾经有过一个真实缺陷：WorkspaceShell 给 EditorPanel 传的内联箭头函数
 * （`onDocLoaded={(doc) => setDocs(...)}`）引用每次父渲染都会变，而它又出现在
 * EditorPanel 里 `load` 的依赖数组中，于是形成闭环：
 *
 *     load → onDocLoaded → 父组件 setState → 重渲染 → 新的 onDocLoaded
 *     → load 重建 → useEffect 重跑 → load …
 *
 * 症状是"在笔记里新建文档就疯狂闪烁 + 终端被 /api/blocks 请求刷屏"。
 * 这类缺陷**类型检查抓不到、纯函数测试也抓不到** —— 它只在组件真的被渲染、
 * effect 真的跑起来时才暴露。所以这里用 react-dom 真渲染一次，
 * 并数一数到底发了几次请求。
 *
 * 每个组件都用**内联箭头函数**当回调，刻意复现当初触发循环的写法：
 * 如果谁把子组件里的 `useStableCallback` 去掉，或者把回调塞回依赖数组，
 * 这里的请求计数就会爆掉。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, useState } from "react";
import { act, create } from "react-test-renderer";

/* ------------------------------------------------------------------ *
 * 测试环境准备
 *
 * 必须在动态 import 组件之前设好：这些组件在渲染期会读 window / 发 fetch。
 * ------------------------------------------------------------------ */

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/*
 * react-test-renderer 在 React 19 里会打印一条 deprecation 警告。
 * 它对本测试无害（我们只是要"让组件真的渲染起来"），但会让测试输出很吵，
 * 所以这里把它过滤掉 —— 只滤这一条，别的一律放行。
 */
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && first.includes("react-test-renderer is deprecated")) {
    return;
  }
  originalConsoleError(...args);
};

/*
 * 最小化的 window 桩。
 *
 * react-test-renderer 不提供 DOM，而组件里有三类浏览器 API 调用点：
 *  - `window.confirm`（删除确认）
 *  - `window.addEventListener("keydown", …)`（Ctrl/Cmd+S 保存）
 *  - `process.env.NODE_ENV` 判断
 * 这里只补这些，够组件挂载即可 —— 测试关心的是"渲染了几次、发了几次请求"，
 * 不是浏览器行为本身。
 */
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

interface MockRoute {
  count: number;
  body: unknown;
}

const routeCalls = new Map<string, MockRoute>();

function mockRoute(match: string, body: unknown): void {
  routeCalls.set(match, { count: 0, body });
}

function callsTo(match: string): number {
  return routeCalls.get(match)?.count ?? 0;
}

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  for (const [match, route] of routeCalls) {
    if (url.includes(match)) {
      route.count += 1;
      return new Response(JSON.stringify(route.body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  return new Response(JSON.stringify({ error: `未 mock 的请求：${url}` }), { status: 404 });
}) as typeof fetch;

/* ------------------------------------------------------------------ *
 * 被测组件的依赖数据
 * ------------------------------------------------------------------ */

const DOC = {
  id: "doc_test",
  workspaceId: "ws_test",
  parentId: null,
  title: "测试文档",
  icon: "",
  sort: 0,
  createdAt: 1,
  updatedAt: 1,
};

const BLOCK = {
  id: "blk_1",
  seq: 0,
  kind: "paragraph",
  cacheKey: "0123456789abcdef",
  path: "测试文档",
  text: "一段正文。",
  refCount: 0,
};

const CONVERSATION = {
  id: "conv_test",
  workspaceId: "ws_test",
  title: "测试会话",
  modelConfigId: "mc_test",
  sourceBudgetTokens: 40000,
  createdAt: 1,
  updatedAt: 1,
};

const MODEL = {
  id: "mc_test",
  name: "测试模型",
  provider: "openai" as const,
  baseUrl: "https://example.invalid/v1",
  model: "test-model",
  apiKeySet: true,
  apiKeyHint: "••••test",
  temperature: 0.3,
  maxTokens: 4096,
  contextWindow: 128000,
  supportsPromptCache: true,
  inputPrice: 1,
  cachedInputPrice: 0.1,
  outputPrice: 2,
  extra: {},
  isDefault: true,
};

/** 渲染一个组件并等所有挂起的 effect / promise 落地 */
async function renderAndSettle(element: React.ReactElement): Promise<() => void> {
  let renderer: ReturnType<typeof create> | null = null;

  await act(async () => {
    renderer = create(element);
  });

  // 再给微任务队列几轮机会，让 fetch → setState 的链条走完。
  // 如果存在渲染循环，这几轮里请求数会继续增长，下面的断言就会抓到。
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  return () => {
    act(() => {
      renderer?.unmount();
    });
  };
}

/** 取组件的渲染次数：react-test-renderer 的 root 只保留最终树，
 *  所以这里改用"请求次数"作为循环的证据 —— 循环必然伴随重复请求。 */

/* ------------------------------------------------------------------ *
 * 1. EditorPanel：新建文档后不能反复拉取
 * ------------------------------------------------------------------ */

test("EditorPanel：内联回调不会造成重复拉取文档（渲染循环回归）", async () => {
  const { default: EditorPanel } = await import("../../src/components/editor-panel.tsx");

  mockRoute("/api/blocks?docId=", {
    doc: DOC,
    markdown: "一段正文。",
    blockIds: [BLOCK.id],
    blocks: [BLOCK],
  });

  const unmount = await renderAndSettle(
    createElement(EditorPanel, {
      docId: DOC.id,
      // 刻意用内联箭头函数 —— 这正是当初触发循环的写法
      onDocLoaded: () => {
        docLoadedCount += 1;
      },
      onReference: () => {},
      referencedBlockIds: [],
      onSaved: () => {},
    }),
  );

  const calls = callsTo("/api/blocks?docId=");
  assert.equal(
    calls,
    1,
    `EditorPanel 只应拉取一次文档，实际 ${calls} 次 —— 大概率是回调被当成了 effect 依赖`,
  );

  unmount();
});

let docLoadedCount = 0;

/* ------------------------------------------------------------------ *
 * 2. EditorPanel：父组件每次渲染传新回调，也不应触发重新拉取
 * ------------------------------------------------------------------ */

test("EditorPanel：父组件传入新回调引用时不重新拉取", async () => {
  const { default: EditorPanel } = await import("../../src/components/editor-panel.tsx");

  const before = callsTo("/api/blocks?docId=");

  // 连续渲染三次，每次都用**全新的**内联函数，模拟父组件频繁重渲染
  const unmounts: (() => void)[] = [];
  for (let i = 0; i < 3; i += 1) {
    unmounts.push(
      await renderAndSettle(
        createElement(EditorPanel, {
          docId: DOC.id,
          onDocLoaded: () => {},
          onReference: () => {},
          referencedBlockIds: [],
          onSaved: () => {},
        }),
      ),
    );
  }

  const added = callsTo("/api/blocks?docId=") - before;
  assert.equal(added, 3, `三次挂载应各拉取一次，实际新增 ${added} 次`);

  for (const unmount of unmounts) unmount();
});

/* ------------------------------------------------------------------ *
 * 3. ChatPanel：挂载时不应反复拉取会话
 * ------------------------------------------------------------------ */

test("ChatPanel：内联回调不会造成重复拉取会话", async () => {
  const { default: ChatPanel } = await import("../../src/components/chat-panel.tsx");

  mockRoute("/api/messages?id=", {
    conversation: CONVERSATION,
    messages: [],
    refBlockIds: [],
    invocations: [],
  });
  mockRoute("/api/preview", { plan: null });

  const unmount = await renderAndSettle(
    createElement(ChatPanel, {
      conversation: CONVERSATION,
      models: [MODEL],
      onRefsChanged: () => {},
      onConversationUpdated: () => {},
      onTurnComplete: () => {},
    }),
  );

  const calls = callsTo("/api/messages?id=");
  assert.ok(calls >= 1, "ChatPanel 至少应拉取一次会话");
  assert.ok(
    calls <= 2,
    `ChatPanel 拉取会话 ${calls} 次，超出预期 —— 可能存在渲染循环`,
  );

  unmount();
});

/* ------------------------------------------------------------------ *
 * 4. useStableCallback 本身的契约
 * ------------------------------------------------------------------ */

test("useStableCallback：跨渲染返回同一引用，且调用的是最新闭包", async () => {
  const { useStableCallback } = await import("../../src/lib/ui/hooks.ts");

  /*
   * 关键点：必须对**同一个组件实例**触发多次重渲染。
   *
   * 每次 createElement + create() 都是一个全新实例、一份全新的 hook 状态，
   * 那种情况下函数引用本来就该不同 —— 拿它来断言"引用恒定"是测错了东西。
   * 这里改成在组件内部用 useState 驱动重渲染。
   */
  const captured: { stable: (() => number) | undefined; observed: number }[] = [];
  let bump: (() => void) | null = null;

  function Probe({ value }: { value: number }) {
    const [tick, setTick] = useState(0);
    bump = () => setTick((t) => t + 1);
    // 每次渲染都传入一个**全新**的箭头函数
    const stable = useStableCallback(() => value + tick);
    captured.push({ stable, observed: stable?.() ?? -1 });
    return null;
  }

  const unmount = await renderAndSettle(createElement(Probe, { value: 10 }));
  const firstRef = captured[0].stable;
  assert.ok(firstRef, "首次渲染应当拿到一个函数");

  // 对同一实例连续触发 3 次重渲染
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      bump?.();
    });
  }

  assert.ok(captured.length >= 4, `探针应至少渲染 4 次，实际 ${captured.length}`);

  for (const entry of captured) {
    assert.equal(
      entry.stable,
      firstRef,
      "useStableCallback 的返回引用必须在同一实例的所有渲染之间保持恒定",
    );
  }

  /*
   * 引用恒定但不能是"陈旧的闭包" —— 必须能读到最新一次渲染的值。
   * 最后一次渲染时 tick = 3，所以应当得到 10 + 3 = 13。
   */
  assert.equal(
    captured.at(-1)?.observed,
    13,
    `应调用最新一次渲染传入的回调，实际得到 ${captured.at(-1)?.observed}`,
  );

  unmount();
});
