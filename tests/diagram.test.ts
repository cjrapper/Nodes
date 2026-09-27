/**
 * 流程图渲染器的测试。
 *
 * 这是一个纯函数模块（源文本 → 布局 → SVG 字符串），所以可以完整地单测：
 * 不需要 DOM、不需要浏览器。重点覆盖四类：
 *
 *  1. **解析容错** —— 写错的行不能静默丢内容，要给出可读警告；
 *  2. **布局确定性** —— 同样的源文本必须产出完全相同的坐标，
 *     否则用户每编辑一次图都会抖一下（而且这是"知识块哈希确定"的前提）；
 *  3. **分层正确性** —— 分支汇合时下层节点必须排在所有父节点之后，
 *     否则连线会向上回折，图会非常难读；
 *  4. **XSS / 注入** —— 标签与链接都要逃逸，跳转协议要受限。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assignLayers,
  defaultLinkResolver,
  estimateLabelWidth,
  layoutDiagram,
  parseDiagram,
  renderDiagram,
  renderDiagramSvg,
} from "../src/lib/render/diagram.ts";

/* ------------------------------------------------------------------ *
 * 1. 解析
 * ------------------------------------------------------------------ */

test("解析标题、节点、标签、边与方向", () => {
  const spec = parseDiagram(`
# 职业方向
客户端 --> 引擎
Unity["Unity 客户端"]
gpu{要不要做图形}
`);

  assert.equal(spec.title, "职业方向");
  assert.equal(spec.warnings.length, 0, `不该有警告：${spec.warnings.join("; ")}`);

  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("Unity")?.label, "Unity 客户端");
  assert.equal(byId.get("Unity")?.shape, "box");
  assert.equal(byId.get("gpu")?.shape, "diamond", "{...} 应当是判断节点");
  // 只出现在边里的节点也要被建出来，标签缺省用 id
  assert.equal(byId.get("客户端")?.label, "客户端");

  assert.equal(spec.edges.length, 1);
  assert.equal(spec.edges[0].from, "客户端");
  assert.equal(spec.edges[0].to, "引擎");
  assert.equal(spec.edges[0].directed, true);
});

test("无向边用 --- 表示，不画箭头", () => {
  const spec = parseDiagram("A --- B");
  assert.equal(spec.edges[0].directed, false);
});

test("边上可以带标注", () => {
  const spec = parseDiagram("A -->|通过| B");
  assert.equal(spec.edges[0].label, "通过");
  assert.equal(spec.edges[0].to, "B");
});

test("节点 id 支持中文", () => {
  const spec = parseDiagram("图形学 --> 渲染管线");
  assert.deepEqual(
    spec.nodes.map((n) => n.id).sort(),
    ["图形学", "渲染管线"],
  );
});

test("带引号的标签可以包含空格与标点", () => {
  const spec = parseDiagram('A["顶点着色器, 片元着色器"]');
  assert.equal(spec.nodes[0].label, "顶点着色器, 片元着色器");
});

test("// 开头的行是注释，被忽略且不产生警告", () => {
  const spec = parseDiagram("// 这是我的笔记\nA --> B");
  assert.equal(spec.nodes.length, 2);
  assert.equal(spec.warnings.length, 0);
});

test("解析不出来的行进入 warnings 而不是被静默吞掉", () => {
  // 属性括号没闭合 —— 这种行必须被明确报出来，而不是当成节点名
  const spec = parseDiagram('A --> B\nC["没闭合的标签 --> D\nE');
  assert.equal(spec.warnings.length, 1, `实际警告：${spec.warnings.join("; ")}`);
  assert.match(spec.warnings[0], /无法解析/);
  // 关键：其它行仍然正常解析，不能因为一行错误就整张图作废
  assert.ok(spec.nodes.some((n) => n.id === "A"));
  assert.ok(spec.nodes.some((n) => n.id === "B"));
  assert.ok(spec.nodes.some((n) => n.id === "E"));
});

test("url: 目标里的括号与查询串不会被截断", () => {
  const resolve = (t: string) => (t.startsWith("url:") ? t.slice(4) : null);
  const spec = parseDiagram("A --> url:https://a.com/x?y=1&z=2", resolve);
  const node = spec.nodes.find((n) => n.id.startsWith("url:"));
  assert.equal(node?.href, "https://a.com/x?y=1&z=2", "查询串必须完整保留");
  assert.deepEqual(spec.warnings, []);
});

test("url:javascript: 这类目标拿不到 href，并给出警告", () => {
  const resolve = (t: string) => {
    // 只放行 http(s)：模拟真实的解析器策略
    return /^url:https?:\/\//i.test(t) ? t.slice(4) : null;
  };
  const spec = parseDiagram("A --> url:javascript:alert(1)", resolve);
  const node = spec.nodes.find((n) => n.id.startsWith("url:"));
  assert.equal(node?.href, null, "危险协议不该得到可点击的 href");
  assert.ok(
    spec.warnings.some((w) => w.includes("无法解析链接目标")),
    `应当警告：${spec.warnings.join("; ")}`,
  );
});

test("空输入不崩，返回空图", () => {
  const spec = parseDiagram("");
  assert.deepEqual(spec.nodes, []);
  assert.deepEqual(spec.edges, []);
  assert.equal(spec.title, null);
});

/* ------------------------------------------------------------------ *
 * 2. 链接
 * ------------------------------------------------------------------ */

test("doc: 与 url: 前缀被解析成可点击节点", () => {
  const resolve = (target: string) => {
    if (target.startsWith("doc:")) return `/?doc=${target.slice(4)}`;
    if (target.startsWith("url:http")) return target.slice(4);
    return null;
  };
  const spec = parseDiagram(
    `
A["跳去文档"] --> doc:doc_abc
A --> url:https://example.com
B --> C
`,
    resolve,
  );

  const byId = new Map(spec.nodes.map((n) => [n.id, n]));

  /*
   * 链接节点的 id **保留完整前缀**（`doc:doc_abc`），好处是：
   *  - 与恰好叫 `doc_abc` 的普通节点不会撞名；
   *  - "同一个目标只对应一个节点"更容易成立。
   * 而显示文字用去掉前缀的部分，免得图上是一串 id。
   */
  assert.equal(byId.get("doc:doc_abc")?.href, "/?doc=doc_abc");
  assert.equal(byId.get("doc:doc_abc")?.label, "doc_abc", "显示文字应去掉 doc: 前缀");
  assert.equal(byId.get("url:https://example.com")?.href, "https://example.com");
  assert.equal(byId.get("B")?.href, null, "普通节点不该被当成链接");
  assert.equal(byId.get("A")?.label, "跳去文档", "左侧带属性的边也要能解析");
  assert.equal(spec.edges.length, 3, `应当有 3 条边，实际 ${spec.edges.length}`);
  assert.ok(
    spec.edges.some((e) => e.from === "A" && e.to === "doc:doc_abc"),
    "带属性的左侧节点与链接目标之间的边必须存在",
  );
  assert.deepEqual(spec.warnings, [], `不该有警告：${spec.warnings.join("; ")}`);
});

test("默认解析器只认 http(s)，其余返回 null（不给用户猜的空间）", () => {
  assert.equal(defaultLinkResolver("https://a.com"), "https://a.com");
  assert.equal(defaultLinkResolver("http://a.com"), "http://a.com");
  assert.equal(defaultLinkResolver("javascript:alert(1)"), null);
  assert.equal(defaultLinkResolver("doc:abc"), null, "doc: 需要调用方提供解析器");
  assert.equal(defaultLinkResolver("随便一个词"), null);
});

test("无法解析的链接目标进入 warnings，节点仍在图里", () => {
  const spec = parseDiagram("A --> doc:nope", () => null);
  assert.ok(
    spec.warnings.some((w) => w.includes("无法解析链接目标")),
    `应当警告：${spec.warnings.join("; ")}`,
  );
  const node = spec.nodes.find((n) => n.id === "doc:nope");
  assert.ok(node, "目标解析失败也不该把节点丢掉");
  assert.equal(node.href, null);
});

/* ------------------------------------------------------------------ *
 * 3. 分层
 * ------------------------------------------------------------------ */

test("分层：无入边的节点在第 0 层，链式依赖逐层递增", () => {
  const spec = parseDiagram("A --> B\nB --> C");
  const layers = assignLayers(
    spec.nodes.map((n) => n.id),
    spec.edges,
  );
  assert.equal(layers.get("A"), 0);
  assert.equal(layers.get("B"), 1);
  assert.equal(layers.get("C"), 2);
});

test("汇合点取最长路径，保证连线不向上回折", () => {
  // A --> C，A --> B --> C：C 必须排在 B 之后（第 2 层），而不是第 1 层
  const spec = parseDiagram("A --> C\nA --> B\nB --> C");
  const layers = assignLayers(
    spec.nodes.map((n) => n.id),
    spec.edges,
  );
  assert.equal(layers.get("A"), 0);
  assert.equal(layers.get("B"), 1);
  assert.equal(layers.get("C"), 2, "C 必须晚于它所有的父节点");
});

test("环形依赖不会死循环，被就地截断", () => {
  const spec = parseDiagram("A --> B\nB --> C\nC --> A");
  const layers = assignLayers(
    spec.nodes.map((n) => n.id),
    spec.edges,
  );
  // 只要不抛异常、每个节点都有层级即可 —— 环形图本来就没有"正确的分层"
  for (const id of ["A", "B", "C"]) {
    assert.equal(typeof layers.get(id), "number", `${id} 应当有层级`);
    assert.ok(Number.isFinite(layers.get(id)));
  }
});

test("孤立节点也在第 0 层，且不会让布局崩掉", () => {
  const spec = parseDiagram("A\nB");
  const layout = layoutDiagram(spec);
  assert.equal(layout.nodes.length, 2);
  assert.ok(layout.width > 0 && layout.height > 0);
});

/* ------------------------------------------------------------------ *
 * 4. 布局确定性与几何
 * ------------------------------------------------------------------ */

test("同样的源文本产出完全相同的布局（确定性的前提）", () => {
  const source = `
# 图
A --> B
A --> C
B --> D
C --> D
D["终点"]
`;
  const runs = Array.from({ length: 5 }, () => renderDiagram(source).svg);
  for (const svg of runs.slice(1)) {
    assert.equal(svg, runs[0], "同样的源文本必须逐字节产出同样的 SVG");
  }
});

test("同层的节点纵向不重叠", () => {
  const spec = parseDiagram("A --> B\nA --> C\nA --> D");
  const layout = layoutDiagram(spec);
  const sameLayer = layout.nodes.filter((n) => n.id !== "A");
  const sorted = [...sameLayer].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    assert.ok(
      sorted[i].y >= prev.y + prev.height,
      `同层节点重叠：${prev.id} 与 ${sorted[i].id}`,
    );
  }
});

test("父节点整体在子节点左侧", () => {
  const spec = parseDiagram("A --> B");
  const layout = layoutDiagram(spec);
  const a = layout.nodes.find((n) => n.id === "A")!;
  const b = layout.nodes.find((n) => n.id === "B")!;
  assert.ok(a.x + a.width <= b.x, "父节点应当在子节点左边，留出连线空间");
});

test("边从父节点右边缘出发、连到子节点左边缘", () => {
  const spec = parseDiagram("A --> B");
  const layout = layoutDiagram(spec);
  const a = layout.nodes.find((n) => n.id === "A")!;
  const b = layout.nodes.find((n) => n.id === "B")!;
  const edge = layout.edges[0];
  assert.equal(edge.x1, a.x + a.width);
  assert.equal(edge.x2, b.x);
  assert.equal(edge.y1, a.y + a.height / 2);
  assert.equal(edge.y2, b.y + b.height / 2);
});

test("判断节点比普通节点高（菱形需要更多空间）", () => {
  const spec = parseDiagram("A\nB{判断}");
  const layout = layoutDiagram(spec);
  const box = layout.nodes.find((n) => n.id === "A")!;
  const diamond = layout.nodes.find((n) => n.id === "B")!;
  assert.ok(diamond.height > box.height);
});

test("列宽随标签长度增长，长标签不会被裁切", () => {
  const short = layoutDiagram(parseDiagram("A"));
  const long = layoutDiagram(parseDiagram('A["这是一个相当长的标签文字内容"]'));
  assert.ok(
    long.width > short.width,
    "长标签应当把列撑宽，否则文字会溢出节点框",
  );
});

/* ------------------------------------------------------------------ *
 * 5. SVG 良构性
 *
 * 这一组守的是一类**字符串断言抓不到**的问题：输出的 SVG 如果 XML 不良构，
 * 浏览器会整块渲染失败（图彻底不显示），而 `assert.match(svg, /<a href=/)`
 * 之类照样能过。所以这里做一次真正的结构检查。
 * ------------------------------------------------------------------ */

/**
 * SVG 里永远自闭合的标签。
 *
 * ⚠️ 这里刻意**只列叶子元素**。`<marker>`、`<defs>`、`<a>`、`<g>` 都是容器，
 * 它们有成对的闭合标签 —— 把它们错列进来会让检查器把 `</marker>`
 * 判成多余，报出假失败（第一版就踩了这个）。
 * 判断依据是"标签后面有没有跟 `/`"，这个集合只是兜底。
 */
const SELF_CLOSING = new Set(["path", "rect", "polygon", "circle", "line", "use", "image"]);

/**
 * 极简 XML 良构性检查。
 *
 * 检查四件事：
 *  1. 标签成对闭合、嵌套顺序正确；
 *  2. 文本节点里没有裸露的 `<`（那会直接破坏解析）；
 *  3. `id` 不重复（重复 id 会让 `url(#x)` 指向不确定的元素）；
 *  4. 所有 `url(#x)` / `href="#x"` 引用的 id 确实存在。
 *
 * 刻意不引入 XML 解析库：这里要验的是"生成器有没有漏逃逸"，
 * 一个几百字节的检查器足够，且不会给项目增加依赖。
 */
function checkWellFormed(svg: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const stack: string[] = [];
  const ids = new Set<string>();
  const refs: string[] = [];

  // 扫描标签与文本，忽略注释
  const withoutComments = svg.replace(/<!--[\s\S]*?-->/g, "");
  const tagRe = /<\/?([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;

  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(withoutComments)) !== null) {
    const [, name, attrs, selfClose, text] = match;

    if (text !== undefined) {
      // 文本里的 `&` 必须是实体开头；裸露的 `<` 会在上面的分支里被吃掉，
      // 所以这里只需要确认 `&` 不是孤立的
      if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(text)) {
        problems.push(`文本里有未转义的 &：${text.slice(0, 40)}`);
      }
      continue;
    }

    if (match[0].startsWith("</")) {
      const open = stack.pop();
      if (open !== name) {
        problems.push(`标签闭合不匹配：期望 </${open ?? "(无)"}>，实际 </${name}>`);
      }
      continue;
    }

    // 收集 id 与引用
    const idMatch = /\bid="([^"]+)"/.exec(attrs);
    if (idMatch) {
      if (ids.has(idMatch[1])) problems.push(`id 重复：${idMatch[1]}`);
      ids.add(idMatch[1]);
    }
    for (const ref of attrs.matchAll(/(?:url\(#|href="#)([^)"]+)/g)) {
      refs.push(ref[1]);
    }

    const isSelfClosing = selfClose === "/" || SELF_CLOSING.has(name);
    if (!isSelfClosing) stack.push(name);
  }

  if (stack.length > 0) problems.push(`有未闭合的标签：${stack.join(", ")}`);
  for (const ref of refs) {
    if (!ids.has(ref)) problems.push(`引用了不存在的 id：${ref}`);
  }

  return { ok: problems.length === 0, problems };
}

test("生成的 SVG 是良构的（浏览器不会整块渲染失败）", () => {
  const sources = [
    "A --> B",
    'A["带 空格 和,标点"] --> B\nB --> C\nC --> A',
    "# 标题\n掉帧 --> 合批\n掉帧 --> 过绘制\n合批 --> 抓帧\n过绘制{判断} --> 抓帧",
    'A --> url:https://example.com/x?y=1&z=2',
    "孤立节点",
    'A["<script>alert(1)</script>"] --> B',
    'A["带 & 符号"] --> B["还有 <b> 标签"]',
  ];

  for (const source of sources) {
    const { svg } = renderDiagram(source, (t) =>
      t.startsWith("url:") ? t.slice(4) : null,
    );
    const { ok, problems } = checkWellFormed(svg);
    assert.ok(
      ok,
      `源文本 ${JSON.stringify(source)} 产出的 SVG 不良构：\n${problems.join("\n")}`,
    );
  }
});

test("marker 的 id 被引用且只定义一次", () => {
  const { svg } = renderDiagram("A --> B\nC --> D");
  assert.match(svg, /id="nodes-arrow"/);
  assert.match(svg, /url\(#nodes-arrow\)/);
  // 每条有向边都会引用它，但定义只应出现一次
  const definitions = svg.match(/id="nodes-arrow"/g) ?? [];
  assert.equal(definitions.length, 1, "marker 不能重复定义，否则引用指向不确定");
});

test("无向边不引用箭头 marker", () => {
  const { svg } = renderDiagram("A --- B");
  assert.equal(svg.includes("url(#nodes-arrow)"), false);
});

test("标签里的 & 被转义成实体，不会截断 XML", () => {
  const { svg } = renderDiagram('A["A & B"]');
  assert.match(svg, /A &amp; B/);
  assert.equal(checkWellFormed(svg).ok, true);
});

test("空图与只有警告的图也是良构的", () => {
  for (const source of ["", '["只有属性"]', "   \n  "]) {
    const { svg } = renderDiagram(source);
    const { ok, problems } = checkWellFormed(svg);
    assert.ok(ok, `${JSON.stringify(source)} 产出不良构 SVG：${problems.join("; ")}`);
  }
});

test("中文按整字宽估算，英文按半宽", () => {
  const zh = estimateLabelWidth("图形学");
  const en = estimateLabelWidth("abc");
  assert.ok(zh > en, `中文(${zh}) 应当比同长度英文(${en}) 宽`);
});

/* ------------------------------------------------------------------ *
 * 5. SVG 输出与注入
 * ------------------------------------------------------------------ */

test("输出是合法的 SVG 骨架，且带 viewBox", () => {
  const { svg } = renderDiagram("A --> B");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<\/svg>$/);
});

test("可点击节点用 <a href> 包裹，不可点的用 <g>", () => {
  const resolve = (t: string) => (t.startsWith("doc:") ? `/?doc=${t.slice(4)}` : null);
  const { svg } = renderDiagram('A["去文档"] --> doc:doc_x\nB --> C', resolve);
  assert.match(svg, /<a href="\/\?doc=doc_x"/);
  assert.match(svg, /<g>/);
});

test("标签里的尖括号与引号被逃逸，不会构成注入", () => {
  const { svg } = renderDiagram('A["<script>alert(1)</script>"]');
  assert.equal(svg.includes("<script>"), false, "标签内容必须逃逸");
  assert.match(svg, /&lt;script&gt;/);
});

test("链接里的引号被逃逸，无法闭合 href 属性", () => {
  const resolve = () => 'https://a.com/" onmouseover="alert(1)';
  const { svg } = renderDiagram('A --> doc:x', resolve);
  assert.equal(svg.includes('onmouseover="alert(1)"'), false);
  assert.match(svg, /&quot;/);
});

test("标题里的特殊字符也被逃逸", () => {
  const { svg } = renderDiagram('# <img src=x onerror=1>\nA --> B');
  assert.equal(/<img[\s/>]/.test(svg), false);
});

test("空图返回占位 SVG 而不是抛异常", () => {
  const { svg } = renderDiagram("");
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
});

test("只有警告、没有任何节点时也不崩", () => {
  const { svg, spec } = renderDiagram('["只有属性没有 id"]');
  assert.ok(spec.warnings.length > 0, `应当有警告：${spec.warnings.join("; ")}`);
  assert.match(svg, /^<svg /);
});

test("renderDiagramSvg 是纯函数：同样的布局产出同样的字符串", () => {
  const layout = layoutDiagram(parseDiagram("A --> B\nB --> C"));
  assert.equal(renderDiagramSvg(layout), renderDiagramSvg(layout));
});
