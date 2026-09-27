/**
 * ChatPanel 的渲染循环回归测试。
 *
 * ## 背景
 *
 * 看门狗在真实使用中报过两次渲染循环：
 *  - 第一次在 `EditorPanel`（大纲的 IntersectionObserver 无条件 setState）；
 *  - 第二次在 `ChatPanel`，触发路径是点模块概览页的 AI 按钮。
 *
 * 两次都是"用户先在浏览器里看到"，说明组件测试没覆盖到真实触发路径。
 * 所以这个文件专门盯 ChatPanel：**把真实的 API 往返都桩起来，数它渲染了几次**。
 *
 * ## 两个关键设计
 *
 * 1. **更新 prop 而不是重挂载。** 循环发生在"同一个实例被反复重渲染"时，
 *    所以必须让宿主组件保持挂载、只换 prop。重挂载会把计数洗掉。
 * 2. **桩全部接口。** ChatPanel 挂载时会拉会话、请求缓存预览；挂模块时还要
 *    PATCH 会话。少桩一个，测的就是"网络错误怎么处理"而不是渲染次数。
 * 3. **用专属 id 限定接管范围**（AGENTS.md R2）—— 同进程里别的测试文件
 *    也覆写 fetch，宽泛前缀会互相截胡。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, Profiler, useRef, useState } from "react";
import { act, create } from "react-test-renderer";

/* ---------------- 环境桩 ---------------- */

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

class StubIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
  root = null;
  rootMargin = "";
  thresholds = [];
}
globalThis.IntersectionObserver = StubIntersectionObserver as unknown as typeof IntersectionObserver;
globalThis.CSS = { escape: (s: string) => s } as unknown as typeof CSS;

/* ---------------- 测试数据 ---------------- */

const CHAT_ID = "conv_chatloop_test";
const CHAT_DOC = "doc_chatloop_test";

const CONVERSATION = {
  id: CHAT_ID,
  workspaceId: "ws_t",
  title: "循环复现会话",
  modelConfigId: "mc_t",
  sourceBudgetTokens: 40000,
  createdAt: 1,
  updatedAt: 1,
};

const MODEL = {
  id: "mc_t",
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

const PLAN = {
  modelName: "测试模型",
  provider: "openai",
  model: "test-model",
  layers: [
    {
      name: "L0_persona",
      title: "L0 身份内核",
      hint: "",
      tokens: 2000,
      unchanged: false,
      hasBreakpoint: true,
    },
  ],
  prediction: {
    verdict: "cold",
    predictedCachedTokens: 0,
    predictedWriteTokens: 2000,
    predictedMissTokens: 2000,
    stablePrefixTokens: 2000,
    totalInputTokens: 2000,
    belowCacheFloor: false,
    cacheFloorTokens: 1024,
  },
  invalidation: { fromLayer: "L0_persona", reason: "cold_start", detail: "首轮" },
  breakpointNote: "无",
  omittedBlockIds: [],
  orderedBlockIds: [],
  blockTokens: [],
  totalTokens: 2000,
  contextWindow: 128000,
  sourceBudgetTokens: 40000,
  warnings: [],
};

const calls = new Map<string, number>();
const bump = (key: string) => calls.set(key, (calls.get(key) ?? 0) + 1);

function installFetchStub() {
  calls.clear();
  const fallback = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.includes(`/api/messages?id=${CHAT_ID}`)) {
      bump("messages");
      // 每次都返回**全新的对象**，与真实服务端一致 —— 这正是能暴露循环的地方
      return new Response(
        JSON.stringify({
          conversation: { ...CONVERSATION },
          messages: [],
          refBlockIds: [],
          refDocIds: [],
          invocations: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("/api/preview")) {
      bump("preview");
      return new Response(JSON.stringify({ plan: { ...PLAN } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/api/conversations") && init?.method === "PATCH") {
      bump("patchConversation");
      return new Response(JSON.stringify({ conversation: { ...CONVERSATION } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return fallback(input, init);
  }) as typeof fetch;
}

const { default: ChatPanel } = await import("../../src/components/chat-panel.tsx");

/* ---------------- 脚手架 ---------------- */

interface PendingRunShape {
  token: number;
  docIds: string[];
  content: string;
}

/**
 * 保持挂载的宿主：只换 `pendingRun`，不重建 ChatPanel。
 *
 * 用 ref 把"注入任务"的能力暴露给测试，避免测试自己去 create 一棵新树
 * （那等于重挂载，会把渲染计数洗掉，测不出循环）。
 */
function makeHost() {
  const api = {
    push: (_run: PendingRunShape) => {},
  };

  function Host() {
    const [run, setRun] = useState<PendingRunShape | null>(null);
    const setRef = useRef(setRun);
    setRef.current = setRun;
    api.push = (next) => setRef.current(next);

    return createElement(ChatPanel, {
      conversation: CONVERSATION,
      models: [MODEL],
      onRefsChanged: () => {},
      onConversationUpdated: () => {},
      onTurnComplete: () => {},
      onPlanChanged: () => {},
      pendingRun: run,
      onConsumePendingRun: () => {},
    });
  }

  return { Host, api };
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountChat() {
  installFetchStub();
  let commits = 0;
  const { Host, api } = makeHost();

  let renderer: ReturnType<typeof create> | null = null;
  await act(async () => {
    renderer = create(
      createElement(Profiler, { id: "ChatPanel", onRender: () => void (commits += 1) }, createElement(Host)),
    );
  });
  await settle();

  return {
    commits: () => commits,
    call: (key: string) => calls.get(key) ?? 0,
    inject: async (run: PendingRunShape) => {
      await act(async () => {
        api.push(run);
      });
      await settle(10);
    },
    unmount: () => act(() => renderer?.unmount()),
  };
}

/* ---------------- 测试 ---------------- */

test("挂载后渲染次数收敛（不应有渲染循环）", async () => {
  const h = await mountChat();
  const commits = h.commits();
  console.log(
    `[chat-loop] 挂载 commits=${commits} messages=${h.call("messages")} preview=${h.call("preview")}`,
  );

  assert.ok(commits <= 10, `ChatPanel 挂载阶段渲染了 ${commits} 次，疑似循环`);
  assert.ok(h.call("messages") <= 2, `会话被拉了 ${h.call("messages")} 次`);
  h.unmount();
});

test("注入 AI 任务（模块概览页的按钮）后不应形成循环", async () => {
  const h = await mountChat();
  const before = h.commits();

  /*
   * 这是用户真实触发的路径：点「查漏补缺 / 评判修改」→ 上层把一个
   * pendingRun 塞进 ChatPanel → 面板挂载模块并自动发送。
   */
  await h.inject({ token: 1, docIds: [CHAT_DOC], content: "评判一下这个模块" });

  const added = h.commits() - before;
  console.log(
    `[chat-loop] 注入后新增 commits=${added} patch=${h.call("patchConversation")} messages=${h.call("messages")} preview=${h.call("preview")}`,
  );

  assert.ok(
    added <= 15,
    `注入一个 AI 任务后渲染了 ${added} 次 —— effect 在自激`,
  );
  assert.ok(
    h.call("patchConversation") <= 3,
    `PATCH 被调了 ${h.call("patchConversation")} 次，正常应当只有 1 次`,
  );

  h.unmount();
});
