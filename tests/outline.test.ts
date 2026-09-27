/**
 * 大纲面板的契约测试。
 *
 * 分两层：
 *
 *  1. `parseHeadings` —— 层级组装规则。这是面板里唯一的纯逻辑，也是最容易
 *     被改坏的地方：跳级（h1 直接跟 h3）、同级回退、以 h2 开头，都是中文
 *     手写文档里极常见的形态，一条错了大纲就会整体错位。
 *
 *  2. 组件渲染 —— 缩进、计数、空态、过滤、跳转回调。用 react-test-renderer
 *     真渲染一次，能抓到纯函数测试抓不到的接线错误（例如缩进写成动态拼的
 *     Tailwind 类名 → 界面上所有标题都顶格）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";

import OutlinePanel, {
  parseHeadings,
  type HeadingNode,
  type OutlineBlock,
} from "../src/components/outline-panel.tsx";

/* ------------------------------------------------------------------ *
 * 测试辅助
 * ------------------------------------------------------------------ */

function heading(id: string, text: string, seq = 0): OutlineBlock {
  return { id, kind: "heading", text, seq };
}

function other(id: string, kind: string, text: string, seq = 0): OutlineBlock {
  return { id, kind, text, seq };
}

/** 拍成带缩进的 `H层级 标题` 行：层级错位一眼可见 */
function sketch(nodes: readonly HeadingNode[], depth = 0): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push(`${"  ".repeat(depth)}H${node.level} ${node.title}`);
    lines.push(...sketch(node.children, depth + 1));
  }
  return lines;
}

/* ================================================================== *
 * 第一部分：parseHeadings
 * ================================================================== */

test("基本层级：h1 > h2 > h3 逐级嵌套", () => {
  const tree = parseHeadings([
    heading("a", "# 部署手册"),
    heading("b", "## 回滚流程"),
    heading("c", "### 灰度回滚"),
  ]);

  assert.deepEqual(sketch(tree), ["H1 部署手册", "  H2 回滚流程", "    H3 灰度回滚"]);
  assert.equal(tree.length, 1, "只应有一个根节点");
  assert.equal(tree[0].id, "a");
  assert.equal(tree[0].children[0].id, "b");
  assert.equal(tree[0].children[0].children[0].id, "c");
  assert.deepEqual(tree[0].children[0].children[0].children, []);
  assert.equal(tree[0].title.includes("#"), false, "title 必须去掉前导 #");
});

test("level 跳跃合法：h1 直接接 h3 时，h3 是 h1 的子节点", () => {
  const tree = parseHeadings([heading("h1", "# 顶层"), heading("h3", "### 跳级小节")]);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].children.length, 1, "h3 必须挂在 h1 下，而不是被丢掉");
  assert.equal(tree[0].children[0].id, "h3");
  assert.equal(tree[0].children[0].level, 3);
  assert.deepEqual(sketch(tree), ["H1 顶层", "  H3 跳级小节"]);
  // 不允许为了"补齐层级"凭空造出 h2 占位节点：那会让大纲里出现文档里根本没有的标题
  assert.equal(
    sketch(tree).some((line) => line.includes("H2")),
    false,
    "跳级不应产生 h2 占位节点",
  );
});

test("同级回退：h2 → h3 → h2，第二个 h2 与第一个 h2 平级", () => {
  const tree = parseHeadings([
    heading("a", "## 甲"),
    heading("b", "### 甲之一"),
    heading("c", "## 乙"),
  ]);

  assert.deepEqual(tree.map((n) => n.id), ["a", "c"]);
  assert.equal(tree[0].children.length, 1);
  assert.equal(tree[0].children[0].id, "b");
  assert.deepEqual(tree[1].children, [], "第二个 h2 不该继承上一个 h2 的子树");
  assert.deepEqual(sketch(tree), ["H2 甲", "  H3 甲之一", "H2 乙"]);
});

test("文档以 h2 开头（栈为空）时它就是根节点", () => {
  const tree = parseHeadings([heading("a", "## 直接从二级开始"), heading("b", "### 子节")]);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, "a");
  assert.equal(tree[0].level, 2);
  assert.deepEqual(tree[0].children.map((n) => n.id), ["b"]);
});

test("非标题块被忽略，且不打乱标题的相对顺序", () => {
  const blocks: OutlineBlock[] = [
    heading("h1", "# 甲"),
    other("p1", "paragraph", "正文段落"),
    heading("h2a", "## 甲之一"),
    other("code1", "code", "```\n# 代码里的井号不是标题\n```"),
    heading("h3", "### 甲之一之一"),
    other("q1", "quote", "> # 引用里的井号也不是标题"),
    other("list1", "list", "- 列表项"),
    heading("h2b", "## 甲之二"),
  ];

  const tree = parseHeadings(blocks);

  assert.deepEqual(sketch(tree), [
    "H1 甲",
    "  H2 甲之一",
    "    H3 甲之一之一",
    "  H2 甲之二",
  ]);
  assert.equal(tree[0].children.length, 2, "第二个 h2 应与第一个 h2 平级");
  assert.equal(tree[0].children[1].id, "h2b");
  assert.equal(
    sketch(tree).some((line) => line.includes("井号")),
    false,
    "代码块 / 引用块里以 # 开头的行不能变成标题",
  );
});

test("空标题（只有 #### 没有文字）保留，title 为空字符串", () => {
  const tree = parseHeadings([heading("h1", "# 有文字"), heading("empty", "####")]);

  assert.equal(tree.length, 2, "空标题不能被丢掉");
  assert.equal(tree[1].id, "empty");
  assert.equal(tree[1].title, "");
  // 规则：/^(#{1,6})\s+(.*)$/ 解析不出来的一律按 level 1 兜底。
  // `####` 没有跟空白，正则失配，因此它是 level 1 —— 界面上仍会显示
  // 「（无标题）」，不会因为解析失败就消失。
  assert.equal(tree[1].level, 1);
});

test("正则解析不出来的一律 level 1 兜底（不丢块、不产生 NaN）", () => {
  const tree = parseHeadings([
    heading("plain", "没有井号的一行"),
    heading("seven", "####### 七个井号"),
    heading("nospace", "#没有空格"),
  ]);

  assert.equal(tree.length, 3);
  assert.deepEqual(tree.map((n) => n.level), [1, 1, 1]);
  assert.deepEqual(tree.map((n) => n.title), ["没有井号的一行", "七个井号", "没有空格"]);
});

test("标题块带尾巴（首尾空白 / 换行）时仍按真实层级解析", () => {
  const tree = parseHeadings([heading("a", "  ## 带空白的标题  \n"), heading("b", "### 子节\n")]);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].level, 2);
  assert.equal(tree[0].title, "带空白的标题");
  assert.deepEqual(tree[0].children.map((n) => n.id), ["b"], "行尾换行不该让标题降级成 level 1");
});

test("seq 原样带进节点，输出顺序与块出现顺序一致", () => {
  const tree = parseHeadings([
    heading("a", "# 甲", 0),
    heading("b", "## 乙", 3),
    heading("c", "# 丙", 7),
  ]);

  assert.deepEqual(
    tree.map((n) => [n.id, n.seq]),
    [
      ["a", 0],
      ["c", 7],
    ],
  );
  assert.deepEqual(tree[0].children.map((n) => [n.id, n.seq]), [["b", 3]]);
});

test("空输入 / 完全没有标题时返回空数组", () => {
  assert.deepEqual(parseHeadings([]), []);
  assert.deepEqual(
    parseHeadings([other("p", "paragraph", "只有正文"), other("c", "code", "```\nx\n```")]),
    [],
  );
});

/* ================================================================== *
 * 第二部分：组件渲染
 * ================================================================== */

// 让 act() 不再打印"环境未声明"的警告（不这样 React 会认为不在测试环境里）
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// react-test-renderer 在 React 19 里会打印一条 deprecation 警告；它对本测试无害，
// 但会把输出弄得很吵，所以只滤这一条（其它一律放行）。
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && first.includes("react-test-renderer is deprecated")) return;
  originalConsoleError(...args);
};

function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "children" in node) {
    return textOf((node as { children: unknown }).children);
  }
  return "";
}

type Renderer = ReturnType<typeof create>;

function renderPanel(
  blocks: OutlineBlock[],
  props: { activeBlockId?: string | null; onNavigate?: (blockId: string) => void } = {},
): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = create(
      createElement(OutlinePanel, {
        blocks,
        activeBlockId: props.activeBlockId ?? null,
        onNavigate: props.onNavigate ?? (() => {}),
      }),
    );
  });
  return renderer;
}

/**
 * 大纲项（`li`）的标签与 props。
 *
 * ⚠️ 一个 `li` 里现在有**两个** button：折叠箭头和标题本身。所以不能再用
 * `findByType("button")`（多匹配会抛错），必须挑出真正承载标题的那个。
 *
 * ⚠️⚠️ 而且**不能拿 li 的 textContent 当标签**！折叠箭头与后代计数徽标
 * （收起时显示的 "3"）也在 li 里，会被拼进标题文字，得到 `"乙3"` 这种结果。
 * 第一版就是这么写的，于是"折叠后标签应当少一项"的断言莫名其妙地失败 ——
 * 又是手写检查器自己的 bug（见 AGENTS.md R4）。判据必须精确到标题按钮内部。
 */
function outlineItems(renderer: Renderer): {
  label: string;
  props: Record<string, unknown>;
  indent: string | undefined;
  collapsed: boolean | null;
}[] {
  return renderer.root.findAllByType("li").map((li) => {
    const buttons = li.findAllByType("button");
    // 标题按钮：title 形如 `H2 · 小节名`（折叠箭头用的是"折叠"/"展开"）
    const titleButton = buttons.find(
      (b) => typeof b.props.title === "string" && /^H\d/.test(b.props.title),
    );
    assert.ok(titleButton, `每个大纲项都应有一个标题按钮，实际 ${buttons.length} 个按钮`);

    // 标签 = 标题按钮里面那个带文字的 span 的内容，
    // 显式排除掉"高亮条"（无文字）与"后代计数徽标"（数字，在标题之后）
    const textSpan = titleButton
      .findAllByType("span")
      .find((s) => typeof s.props.className === "string" && s.props.className.includes("break-words"));
    const label = textSpan ? textOf(textSpan.children) : textOf(titleButton.children);

    // 缩进挂在"最靠左的那个元素"上：有子节点时是折叠箭头，否则是占位 span
    const toggle = buttons.find((b) => b !== titleButton);
    const spacer = li
      .findAllByType("span")
      .find((s) => s.props.style && "marginLeft" in (s.props.style as object));
    const indentSource = toggle ?? spacer;
    const indent = indentSource
      ? ((indentSource.props.style ?? {}) as { marginLeft?: string }).marginLeft
      : undefined;

    return {
      label,
      props: titleButton.props as Record<string, unknown>,
      indent,
      // aria-expanded 只出现在折叠箭头上；没有子节点时为 null
      collapsed:
        typeof toggle?.props["aria-expanded"] === "boolean"
          ? !toggle.props["aria-expanded"]
          : null,
    };
  });
}

/** 点击某一项的折叠箭头。返回 false 表示该项没有箭头（没有子节点）。 */
function toggleAt(renderer: Renderer, index: number): boolean {
  const li = renderer.root.findAllByType("li")[index];
  if (!li) return false;
  const buttons = li.findAllByType("button");
  const toggle = buttons.find((b) => typeof b.props["aria-expanded"] === "boolean");
  if (!toggle) return false;
  act(() => {
    (toggle.props.onClick as () => void)();
  });
  return true;
}

function typeFilter(renderer: Renderer, value: string): void {
  const input = renderer.root.findByType("input");
  act(() => {
    (input.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value },
    });
  });
}

test("面板：按层级缩进 0/12/24px，标题去掉 #，底部统计小节数", () => {
  const renderer = renderPanel([
    heading("a", "# 甲"),
    heading("b", "## 乙"),
    heading("c", "### 丙"),
  ]);

  const items = outlineItems(renderer);
  assert.deepEqual(items.map((i) => i.label), ["甲", "乙", "丙"], "标题文字必须去掉前导 #");
  assert.deepEqual(
    items.map((i) => i.indent),
    ["0px", "12px", "24px"],
    "缩进必须落在内联 style 上（动态 Tailwind 类名不会被生成）",
  );

  const all = textOf(renderer.toJSON());
  assert.ok(all.includes("共 3 个小节"), `底部应显示小节计数，实际文本：${all}`);

  // 输入框有无障碍标注与 placeholder
  const input = renderer.root.findByType("input");
  assert.equal(input.props.placeholder, "过滤标题…");
  const label = renderer.root.findByType("label");
  assert.equal(String(label.props.className).includes("sr-only"), true);
  assert.equal(label.props.htmlFor, input.props.id, "label 必须绑定到输入框");

  act(() => renderer.unmount());
});

test("面板：标题超过 12 个时列表区自身可滚动", () => {
  const listClass = (count: number): string => {
    const renderer = renderPanel(
      Array.from({ length: count }, (_, i) => heading(`h${i}`, `# 标题 ${i + 1}`)),
    );
    const scroller = renderer.root
      .findAllByType("div")
      .map((div) => String(div.props.className ?? ""))
      .find((className) => className.includes("overflow-y-auto"));
    act(() => renderer.unmount());
    return scroller ?? "";
  };

  assert.equal(listClass(12).includes("max-h-"), false, "12 个及以内不需要限制高度");
  assert.equal(listClass(13).includes("max-h-"), true, "超过 12 个应该让列表区自己滚动");
});

test("面板：activeBlockId 对应的项被标成当前项，且只有它用强调色", () => {
  const renderer = renderPanel([heading("a", "# 甲"), heading("b", "## 乙")], {
    activeBlockId: "b",
  });

  const items = outlineItems(renderer);
  const current = items.filter((i) => i.props["aria-current"] === "true");
  assert.equal(current.length, 1, "当前项必须唯一");
  assert.equal(current[0].label, "乙");
  assert.equal(
    String(current[0].props.className).includes("text-[#3ddc97]"),
    true,
    "当前项应使用强调色",
  );
  assert.equal(String(items[0].props.className).includes("text-[#3ddc97]"), false);

  act(() => renderer.unmount());
});

test("面板：过滤只保留命中项及其祖先标题（忽略大小写）", () => {
  const renderer = renderPanel([
    heading("a", "# 部署手册"),
    heading("b", "## 回滚流程"),
    heading("c", "### 灰度回滚"),
    heading("d", "## 监控告警"),
    heading("e", "## API 设计"),
  ]);

  typeFilter(renderer, "回滚");

  const items = outlineItems(renderer);
  assert.deepEqual(
    items.map((i) => i.label),
    ["部署手册", "回滚流程", "灰度回滚"],
    "命中项与它的祖先都要在，未命中的分支要消失",
  );
  // 祖先只是"为了保住层级"才出现，渲染上要更弱
  //
  // 断言的是 CSS 变量引用而不是具体色值：文字色现在是用户可调的外观项
  // （`--nodes-ink-dim` 的默认值就是原来的 #98a2b3），写死色值会让测试
  // 在用户改过外观之后失去意义。
  assert.equal(String(items[0].props.className).includes("text-[var(--nodes-ink-dim)]"), true);
  assert.equal(String(items[1].props.className).includes("text-[var(--nodes-ink)]"), true);
  assert.ok(textOf(renderer.toJSON()).includes("匹配 3"), "过滤时应给出命中数");

  // 不区分大小写；祖先（h1 部署手册）仍然被保留下来撑住层级
  typeFilter(renderer, "api");
  assert.deepEqual(outlineItems(renderer).map((i) => i.label), ["部署手册", "API 设计"]);

  // 空查询恢复全部
  typeFilter(renderer, "");
  assert.equal(outlineItems(renderer).length, 5);

  act(() => renderer.unmount());
});

test("面板：过滤无命中时给出提示，而不是留下一片空白", () => {
  const renderer = renderPanel([heading("a", "# 甲"), heading("b", "## 乙")]);

  typeFilter(renderer, "不存在的词");

  assert.deepEqual(outlineItems(renderer), []);
  assert.ok(textOf(renderer.toJSON()).includes("没有匹配"));
  assert.ok(textOf(renderer.toJSON()).includes("共 2 个小节"), "计数始终是全量小节数");

  act(() => renderer.unmount());
});

test("面板：没有任何标题时显示引导文案，并说明中文序号不会被识别", () => {
  const renderer = renderPanel([other("p", "paragraph", "只有正文，没有标题")]);

  const all = textOf(renderer.toJSON());
  assert.deepEqual(outlineItems(renderer), []);
  assert.ok(all.includes("这篇文档还没有标题。"));
  assert.ok(all.includes("「一、」「二、」这类中文序号不会被识别为标题。"));
  assert.ok(all.includes("共 0 个小节"));

  act(() => renderer.unmount());
});

test("面板：空标题显示为「（无标题）」，不会被渲染成空行", () => {
  const renderer = renderPanel([heading("a", "# 甲"), heading("empty", "####")]);

  assert.deepEqual(
    outlineItems(renderer).map((i) => i.label),
    ["甲", "（无标题）"],
  );

  act(() => renderer.unmount());
});

test("面板：点击大纲项把块 id 交给 onNavigate", () => {
  const seen: string[] = [];
  const renderer = renderPanel([heading("a", "# 甲"), heading("b", "## 乙")], {
    onNavigate: (blockId) => seen.push(blockId),
  });

  const items = outlineItems(renderer);
  act(() => {
    (items[1].props.onClick as () => void)();
  });

  assert.deepEqual(seen, ["b"]);

  act(() => renderer.unmount());
});

/* ------------------------------------------------------------------ *
 * 折叠
 *
 * 用户的原话是细粒度大纲"食之无味，弃之可惜" —— 一屏几十条同级标题时，
 * 结构感反而消失。折叠是让它在"看骨架"和"看细节"之间切换的能力，
 * 所以下面这些断言的实质是"收起来之后真的少了几行、且还能放回来"。
 * ------------------------------------------------------------------ */

/** 面板里的标题标签（按显示顺序） */
function labels(renderer: Renderer): string[] {
  return outlineItems(renderer).map((i) => i.label);
}

test("折叠：收起的节点连同它的整棵子树一起隐藏", () => {
  const renderer = renderPanel([
    heading("a", "# 甲"),
    heading("b", "## 乙"),
    heading("c", "### 丙"),
    heading("d", "## 丁"),
  ]);

  assert.deepEqual(labels(renderer), ["甲", "乙", "丙", "丁"], "默认全部展开");

  // 折起「乙」→ 它下面的「丙」也应当消失，但同级的「丁」要留着
  assert.equal(toggleAt(renderer, 1), true, "有子节点的项应当有折叠按钮");
  assert.deepEqual(labels(renderer), ["甲", "乙", "丁"], "只隐藏被折节点的后代");

  // 再点一次恢复
  assert.equal(toggleAt(renderer, 1), true);
  assert.deepEqual(labels(renderer), ["甲", "乙", "丙", "丁"], "展开后必须完全恢复原样");

  act(() => renderer.unmount());
});

test("折叠：没有子节点的项不显示折叠按钮（也不显示为 0）", () => {
  const renderer = renderPanel([heading("a", "# 甲")]);

  const li = renderer.root.findAllByType("li")[0];
  const toggles = li.findAllByType("button").filter((b) => typeof b.props["aria-expanded"] === "boolean");
  assert.equal(toggles.length, 0, "叶子节点不该有折叠箭头");

  act(() => renderer.unmount());
});

test("折叠：收起时提示里面还藏着多少条", () => {
  const renderer = renderPanel([
    heading("a", "# 甲"),
    heading("b", "## 乙"),
    heading("c", "### 丙"),
    heading("d", "### 丁"),
  ]);

  toggleAt(renderer, 1); // 折起「乙」
  const all = textOf(renderer.toJSON());
  assert.ok(all.includes("2"), `收起后应显示后代数量，实际文本：${all}`);

  act(() => renderer.unmount());
});

test("折叠：搜索时强制展开 —— 折叠不能把搜索结果藏起来", () => {
  const renderer = renderPanel([
    heading("a", "# 甲"),
    heading("b", "## 乙"),
    heading("c", "### 寻找我"),
    heading("d", "## 丁"),
  ]);

  toggleAt(renderer, 1); // 折起「乙」，「寻找我」随之隐藏
  assert.deepEqual(labels(renderer), ["甲", "乙", "丁"]);

  typeFilter(renderer, "寻找");
  const found = labels(renderer);
  assert.ok(
    found.some((l) => l.includes("寻找我")),
    `搜索命中的标题必须可见，实际：${JSON.stringify(found)}`,
  );

  act(() => renderer.unmount());
});

test("折叠：「全部折叠」只留顶层，再点一次全部展开", () => {
  const renderer = renderPanel([
    heading("a", "# 甲"),
    heading("b", "## 乙"),
    heading("c", "### 丙"),
    heading("d", "# 丁"),
    heading("e", "## 戊"),
  ]);

  assert.deepEqual(labels(renderer), ["甲", "乙", "丙", "丁", "戊"]);

  const collapseAll = renderer.root
    .findAllByType("button")
    .find((b) => String(b.props["aria-label"] ?? "").includes("折叠全部"));
  assert.ok(collapseAll, "标题行应该有「全部折叠」按钮");

  act(() => {
    (collapseAll.props.onClick as () => void)();
  });
  assert.deepEqual(labels(renderer), ["甲", "丁"], "全部折叠后只剩顶层");

  const expandAll = renderer.root
    .findAllByType("button")
    .find((b) => String(b.props["aria-label"] ?? "").includes("展开全部"));
  assert.ok(expandAll, "折叠之后按钮应变成「展开全部」");

  act(() => {
    (expandAll.props.onClick as () => void)();
  });
  assert.deepEqual(labels(renderer), ["甲", "乙", "丙", "丁", "戊"], "展开后必须完全恢复");

  act(() => renderer.unmount());
});

test("折叠：同级标题不会因为有没有折叠箭头而左右错开", () => {
  /*
   * 叶子节点没有箭头，若不给它一个等宽占位符，同级标题的缩进就会差一个
   * 箭头的宽度 —— 看起来像层级错乱，是最容易漏掉的视觉 bug。
   * 断言方式：同一层级的两项，缩进值必须相同。
   */
  const renderer = renderPanel([
    heading("a", "# 甲"),
    heading("b", "## 乙"),
    heading("c", "### 丙"), // 「乙」有子节点 → 有箭头
    heading("d", "## 丁"), // 「丁」没有子节点 → 只有占位符
  ]);

  const items = outlineItems(renderer);
  const byLabel = Object.fromEntries(items.map((i) => [i.label, i.indent]));
  assert.equal(
    byLabel["乙"],
    byLabel["丁"],
    `同为 H2，「乙」(有箭头) 与「丁」(无箭头) 的缩进必须一致，实际 ${byLabel["乙"]} vs ${byLabel["丁"]}`,
  );

  act(() => renderer.unmount());
});
