/**
 * 「最大输出 = 不限制」的组件回归测试。
 *
 * ## 守的是什么
 *
 * 真实故障（复发过两次）：推理模型的思维链与正文**共用** `max_tokens`，
 * 于是「AI 分析」这类"先想再写"的任务经常把预算全花在思考上，
 * 正文一个字都写不出来。4096 时如此，提到 8192 之后**依然如此** ——
 * 因为问题不在数字大小，而在"填了一个具体数字"。
 *
 * 修法是允许留空 = 不限制（请求里不带 `max_tokens`）。
 *
 * ## 为什么这条断言必须在组件层做
 *
 * 适配器层的测试证明的是"拿到 null 时不发 `max_tokens`"。
 * 但用户点的是这个表单，中间还隔着一段最容易写错的逻辑：
 *
 *     留空 → parseOptionalNumber → undefined → **不放进请求体**
 *
 * `validateForm` 里那套写法的注释是"留空的字段直接不放进请求体，
 * 让后端保持原值" —— 对价格字段那是对的，对输出上限**恰好相反**：
 * 留空是一个必须**主动提交**的取值（null）。照抄那套写法的后果是
 * 界面输入框空了、保存返回 200、库里 8192 还在，下一轮照样被截断。
 * 这是最难查的一类故障（接口成功、数据没改，见 R8）。
 *
 * 所以这里断言的是**请求体里真的有 `maxTokens: null`**，
 * 而不是"界面上看起来空了"。
 */

import assert from "node:assert/strict";
import { createElement } from "react";
import { test } from "node:test";
import { act, create } from "react-test-renderer";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// react-test-renderer 在 React 19 里会打印弃用警告；它对本测试无害，
// 但会把输出弄得很吵，所以只滤这一条（其它一律放行）。
const realConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && first.includes("react-test-renderer is deprecated")) return;
  realConsoleError(...args);
};

/*
 * `openEdit` 里有一次 requestAnimationFrame（把表单滚进视野）。
 * react-test-renderer 没有 DOM，这个 API 也不存在 —— 不补桩的话
 * 点「编辑」会直接抛，测试就会在一个与断言无关的地方失败。
 */
globalThis.requestAnimationFrame = ((cb: (time: number) => void) => {
  cb(0);
  return 0;
}) as unknown as typeof globalThis.requestAnimationFrame;

type Renderer = ReturnType<typeof create>;

/* ------------------------------------------------------------------ */
/* fetch 桩                                                            */
/* ------------------------------------------------------------------ */

interface CapturedRequest {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const requests: CapturedRequest[] = [];

/** 库里现有的模型配置：输出上限停在上一个默认值 8192 */
const baseModel = {
  id: "mc_flash",
  name: "deepseek-flash",
  provider: "openai",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  apiKeySet: true,
  apiKeyHint: "****1234",
  temperature: 0.3,
  contextWindow: 128000,
  supportsPromptCache: true,
  inputPrice: 0.3,
  cachedInputPrice: 0.03,
  outputPrice: 1.2,
  extra: {},
  isDefault: true,
};

/** 当前"库里"的输出上限。改成 null 就能测"已经是不限制"的渲染。 */
let serverMaxTokens: number | null = 8192;

/** 保存成功后组件会重新拉列表；把最后一次保存的内容并进去，让界面与库一致 */
function storedModel(): Record<string, unknown> {
  const save = [...requests]
    .reverse()
    .find((r) => r.method === "PATCH" || r.method === "POST");
  const saved = save ? save.body : {};
  return { ...baseModel, maxTokens: serverMaxTokens, ...saved };
}

/**
 * 安装（或重新安装）fetch 桩。
 *
 * 之所以是个函数而不是一次性赋值：同进程里别的测试文件也会接管
 * `globalThis.fetch`，必须每次挂载前重新装一遍才能保证赢。见 `mountPanel`。
 *
 * ## 只接 `/api/models`，其余原样转发
 *
 * ⚠️ 这一段是踩出来的，不是设计出来的。
 *
 * 第一版直接把 `globalThis.fetch` 整个换掉，结果是**把别的测试文件饿死了**：
 * `tests/ui/render-loop.test.tsx` 靠自己的 fetch 桩数 `/api/documents` 的调用次数，
 * 我的桩一装，它的计数永远是 0，于是
 * 「EditorPanel：内联回调不会造成重复拉取文档」这类用例全线变红 ——
 * 而它们和"最大输出"毫无关系（R13：改 A 导致测 B 的用例变红，而 B 的断言里
 * 根本看不到 A）。
 *
 * 所以这里按 R2 的办法办：**捕获上一个处理器作为 fallback 转发**，
 * 自己只认领 `/api/models` 这一个 URL。这样无论谁先谁后、谁被 import 几次，
 * 每个文件的桩都还能拿到自己那份请求。
 */
function installFetchStub(): void {
  const previous = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    // 不是我的地盘 → 交还给上一个处理器（可能是别的测试文件的桩，也可能是真 fetch）
    if (!url.includes("/api/models")) {
      return previous(input, init);
    }

    const method = init?.method ?? "GET";
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body) as Record<string, unknown>;
    }
    requests.push({ method, url, body });

    const json = (payload: unknown): Response =>
      ({
        ok: true,
        status: 200,
        json: async () => payload,
      }) as unknown as Response;

    if (method === "GET") return json({ models: [storedModel()], priceCatalog: [] });
    return json({ model: storedModel() });
  }) as unknown as typeof globalThis.fetch;
}

installFetchStub();

/* ------------------------------------------------------------------ */
/* 脚手架                                                              */
/* ------------------------------------------------------------------ */

const { default: ModelsPanel } = await import("../../src/components/models-panel.tsx");

async function mountPanel(): Promise<Renderer> {
  /*
   * ⚠️ **每次挂载前**重新安装 fetch 桩，而不是只在模块加载时装一次。
   *
   * `tests/run.mjs` 在同一个进程里 import 所有测试文件，`globalThis.fetch`
   * 是共享的。只在模块加载时装桩的话，谁最后被 import 谁就赢 —— 而
   * 本文件单独跑（`node tests/ui/models-max-tokens.test.tsx`）永远会赢，
   * 全量跑时却会被别的文件顶掉。症状是"单跑全绿、全量全红"，
   * 而失败信息看上去像是组件坏了（列表成了空态）。
   *
   * 这是 R2 记过三次的老毛病，应对办法就是"每次挂载时重新安装"。
   */
  installFetchStub();
  let renderer!: Renderer;
  await act(async () => {
    renderer = create(createElement(ModelsPanel));
  });
  return renderer;
}

function buttonByAriaLabel(renderer: Renderer, label: string) {
  return renderer.root.findAll(
    (node) =>
      node.type === "button" &&
      typeof node.props["aria-label"] === "string" &&
      (node.props["aria-label"] as string).startsWith(label),
  )[0];
}

/** 点开某个模型的「编辑」表单 */
async function openEditForm(renderer: Renderer): Promise<void> {
  const editButton = buttonByAriaLabel(renderer, "编辑模型");
  if (!editButton) {
    const labels = renderer.root
      .findAll((n) => n.type === "button")
      .map((n) => String(n.props["aria-label"] ?? ""))
      .join(" | ");
    const text = JSON.stringify(renderer.toJSON()).slice(0, 600);
    assert.fail(
      `前置条件不成立：没找到任何「编辑模型」按钮。\n按钮：${labels}\n首屏：${text}`,
    );
  }
  await act(async () => {
    (editButton.props.onClick as () => void)();
  });
}

/** 表单里「最大输出 token」那个输入框（靠 placeholder 唯一识别） */
function maxTokensInput(renderer: Renderer) {
  const input = renderer.root
    .findAllByType("input")
    .find((node) => node.props.placeholder === "不限制");
  assert.ok(input, "没找到「最大输出 token」输入框（placeholder 应当是「不限制」）");
  return input;
}

async function typeMaxTokens(renderer: Renderer, value: string): Promise<void> {
  const input = maxTokensInput(renderer);
  await act(async () => {
    (input.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value },
    });
  });
}

async function saveForm(renderer: Renderer): Promise<void> {
  /*
   * 走 `<form onSubmit>`，**不是**保存按钮的 onClick —— 后者是
   * `type="submit"`，React 不会给它挂 onClick，直接调用会得到 undefined。
   * （这正是"看起来在测、其实什么都没测到"的典型入口，见 R3。）
   */
  const form = renderer.root.findAll(
    (node) =>
      node.type === "form" &&
      typeof node.props["aria-labelledby"] === "string" &&
      (node.props["aria-labelledby"] as string).endsWith("form-title"),
  )[0];
  assert.ok(form, "没找到模型配置表单");
  await act(async () => {
    (form.props.onSubmit as (e: { preventDefault: () => void }) => void)({
      preventDefault: () => {},
    });
  });
}

function saveRequests(): CapturedRequest[] {
  return requests.filter((r) => r.method === "PATCH" || r.method === "POST");
}

function lastSaveRequest(): CapturedRequest {
  const save = saveRequests().at(-1);
  assert.ok(save, "没有发出任何保存请求");
  return save;
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

test("清空「最大输出」并保存：请求体里必须带 maxTokens: null", async () => {
  requests.length = 0;
  serverMaxTokens = 8192;
  const renderer = await mountPanel();

  await openEditForm(renderer);
  assert.equal(
    maxTokensInput(renderer).props.value,
    "8192",
    "前置条件不成立：编辑表单没有回填库里的 8192",
  );

  // 用户把输入框清空 —— 这就是"不要限制"这个动作
  await typeMaxTokens(renderer, "");
  await saveForm(renderer);

  const save = lastSaveRequest();
  assert.equal(save.method, "PATCH");
  assert.equal(save.body.id, "mc_flash");
  assert.ok(
    "maxTokens" in save.body,
    "留空**必须**显式提交 maxTokens —— 不放进请求体的话后端会保持原值，" +
      "于是界面空了、库里还是 8192，用户以为改了其实没改",
  );
  assert.equal(
    save.body.maxTokens,
    null,
    "留空要提交 null（= 不限制），不能是 0、空字符串或省略该字段",
  );

  await act(async () => renderer.unmount());
});

test("填一个具体数字并保存：提交的是数字，不是 null", async () => {
  requests.length = 0;
  serverMaxTokens = 8192;
  const renderer = await mountPanel();

  await openEditForm(renderer);
  await typeMaxTokens(renderer, "131072");
  await saveForm(renderer);

  assert.equal(lastSaveRequest().body.maxTokens, 131072);

  await act(async () => renderer.unmount());
});

test("非法值被拦下：不发保存请求", async () => {
  requests.length = 0;
  serverMaxTokens = 8192;
  const renderer = await mountPanel();

  await openEditForm(renderer);
  for (const bad of ["-1", "1.5", "abc"]) {
    await typeMaxTokens(renderer, bad);
    await saveForm(renderer);
    assert.equal(
      saveRequests().length,
      0,
      `「${bad}」不是合法的输出上限，不该发出保存请求`,
    );
  }

  await act(async () => renderer.unmount());
});

test("库里是不限制（null）时，编辑表单显示为空输入框", async () => {
  requests.length = 0;
  serverMaxTokens = null;
  const renderer = await mountPanel();

  await openEditForm(renderer);
  assert.equal(
    maxTokensInput(renderer).props.value,
    "",
    "null 必须渲染成空输入框 —— 显示 'null' 或 0 都会让人以为被限制成了 0",
  );

  await act(async () => renderer.unmount());
  serverMaxTokens = 8192;
});
