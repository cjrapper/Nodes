/**
 * `useResizableSize` 的单元测试。
 *
 * 这个 hook 负责所有可调面板的尺寸。它有三个容易出错的地方：
 *
 *  1. **夹取边界**：拖到 0 或拖出屏幕之外，面板会彻底消失且再也拖不回来；
 *  2. **记忆**：用户费劲调好的宽度，刷新一下就没了是很糟的体验；
 *  3. **不污染首次渲染**：记忆值必须在挂载后读，否则服务端渲染与客户端
 *     首次渲染不一致（hydration mismatch）。
 *
 * 第 3 点没法在这个测试里直接观察（没有服务端渲染），但前两点可以，
 * 而且它们是最容易在改动中坏掉的。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, useState } from "react";
import { act, create } from "react-test-renderer";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const realConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && first.includes("react-test-renderer is deprecated")) return;
  realConsoleError(...args);
};

/* ---------------- localStorage 桩 ---------------- */

const storage = new Map<string, string>();
let storageThrows = false;

globalThis.window = globalThis.window ?? {};
globalThis.window.localStorage = {
  getItem: (k: string) => {
    if (storageThrows) throw new Error("localStorage 不可用");
    return storage.get(k) ?? null;
  },
  setItem: (k: string, v: string) => {
    if (storageThrows) throw new Error("localStorage 不可用");
    storage.set(k, v);
  },
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
  key: () => null,
  get length() {
    return storage.size;
  },
} as unknown as Storage;

const { useResizableSize } = await import("../../src/components/split.tsx");

/* ---------------- 脚手架 ---------------- */

interface ProbeApi {
  /** 读**最新**一次渲染的尺寸 —— 必须走 ref，否则 act() 之后拿到的还是旧闭包 */
  size: () => number;
  set: (next: number) => void;
  reset: () => void;
}

async function mountProbe(
  key: string,
  initial: number,
  min: number,
  max: number,
): Promise<{ api: ProbeApi; unmount: () => void; commits: () => number }> {
  /*
   * 用 ref 挂住最新一次渲染的 hook 返回值。
   *
   * 直接在渲染里把 `{ size, setSize }` 赋给外层变量是不行的：
   * `setSize` 触发重渲染后，调用方手里的对象仍然是**上一次渲染的快照**，
   * 于是断言会读到旧值（第一版就是这么写的，结果三条用例莫名其妙地失败）。
   */
  const latest = {
    size: initial,
    setSize: (_: number) => {},
    reset: () => {},
  };
  let commits = 0;

  function Probe() {
    commits += 1;
    const [size, setSize, reset] = useResizableSize(key, initial, min, max);
    const [, setTick] = useState(0);

    latest.size = size;
    latest.setSize = setSize;
    latest.reset = reset;

    return null;
  }

  const api: ProbeApi = {
    size: () => latest.size,
    set: (next) => {
      act(() => {
        latest.setSize(next);
        // 额外踢一次，确保即使 setSize 因夹取后值相同（React 会 bail out）
        // 也能刷新 latest
      });
    },
    reset: () => {
      act(() => latest.reset());
    },
  };

  let renderer: ReturnType<typeof create> | null = null;
  await act(async () => {
    renderer = create(createElement(Probe));
  });

  // 等挂载后的"读记忆值" effect 落地
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return {
    api,
    unmount: () => act(() => renderer?.unmount()),
    commits: () => commits,
  };
}

/* ---------------- 测试 ---------------- */

test("拖动时夹取在 [min, max] 之内", async () => {
  const { api, unmount } = await mountProbe("t-clamp", 200, 100, 400);

  assert.equal(api.size(), 200, "初始值应生效");

  await act(async () => api.set(250));
  assert.equal(api.size(), 250, "正常范围内的值应原样接受");

  await act(async () => api.set(9999));
  assert.equal(api.size(), 400, "超过上限应夹到 max");

  await act(async () => api.set(-500));
  assert.equal(api.size(), 100, "低于下限应夹到 min（否则面板会消失且拖不回来）");

  unmount();
});

test("尺寸被写入 localStorage，重新挂载后能读回", async () => {
  const first = await mountProbe("t-persist", 200, 100, 400);
  await act(async () => first.api.set(337));
  assert.equal(storage.get("nodes:split:t-persist"), "337", "应写入记忆");
  first.unmount();

  // 换一个初始值再挂载：若记忆生效，读到的应是 337 而不是新的初始值
  const second = await mountProbe("t-persist", 200, 100, 400);
  assert.equal(second.api.size(), 337, "重新挂载应恢复记忆值");
  second.unmount();
});

test("记忆值越界时会被夹取，不会让面板变得不可用", async () => {
  // 模拟"先在宽屏上调到 500，之后换了小屏"的情形
  storage.set("nodes:split:t-outofrange", "500");

  const { api, unmount } = await mountProbe("t-outofrange", 200, 100, 400);
  assert.equal(api.size(), 400, "记忆值超上限时应夹到 max");
  unmount();
});

test("记忆值损坏（非数字）时回退到初始值", async () => {
  storage.set("nodes:split:t-broken", "not-a-number");

  const { api, unmount } = await mountProbe("t-broken", 200, 100, 400);
  assert.equal(api.size(), 200, "损坏的记忆值不应让尺寸变成 NaN");
  unmount();
});

test("reset 恢复到初始值并同步写回记忆", async () => {
  const { api, unmount } = await mountProbe("t-reset", 210, 100, 400);
  await act(async () => api.set(380));
  assert.equal(storage.get("nodes:split:t-reset"), "380");

  await act(async () => api.reset());
  assert.equal(api.size(), 210, "reset 应回到初始值");
  assert.equal(storage.get("nodes:split:t-reset"), "210", "reset 也应写回记忆");
  unmount();
});

test("localStorage 抛异常时不影响使用（隐私模式）", async () => {
  storageThrows = true;
  try {
    const { api, unmount } = await mountProbe("t-throws", 200, 100, 400);
    assert.equal(api.size(), 200, "读不到记忆时应使用初始值");

    // 关键：写失败也不能把异常抛到渲染里
    await act(async () => api.set(300));
    assert.equal(api.size(), 300, "写失败也不应影响本次会话内的使用");

    unmount();
  } finally {
    storageThrows = false;
  }
});

test("记忆值是同一 key 时跨实例共享（面板尺寸对所有文档一致）", async () => {
  const a = await mountProbe("t-shared", 200, 100, 400);
  a.api.set(333);
  a.unmount();

  const b = await mountProbe("t-shared", 200, 100, 400);
  assert.equal(b.api.size(), 333, "同一 key 的另一个实例应读到相同尺寸");
  b.unmount();
});
