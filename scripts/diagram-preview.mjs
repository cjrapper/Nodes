/**
 * 生成一个独立的图表示例页，用于人工核对渲染效果。
 *
 * 为什么需要它：图表渲染器是纯函数、有 37 项单测，但"在真实浏览器里
 * 长什么样"是单测答不了的问题 —— 布局是否重叠、点击热区是否够大、
 * 中文字体是否正常、hover 反馈是否可见。
 *
 * 这个脚本用**与 Next 应用完全相同的代码路径**产出 HTML：
 * 同一个 `renderDiagram`、同一份 `globals.css`。所以在这里看到的样式
 * 就是应用里的样式，不存在"示例好看、应用难看"的偏差。
 *
 * 用法：node scripts/diagram-preview.mjs [输出路径]
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { renderDiagram } from "../src/lib/render/diagram.ts";
import { resolveDiagramLink } from "../src/lib/ui/diagram-links.ts";

const outPath = process.argv[2] ?? path.resolve(process.cwd(), ".data", "diagram-preview.html");

const SAMPLES = [
  {
    name: "分支排查路径（含跳转节点）",
    source: [
      "# 掉帧排查路径",
      "掉帧 --> 看帧率",
      "看帧率 --> 合批",
      "看帧率 --> 过绘制",
      "合批 --> doc:doc_abc123",
      "过绘制{要不要抓帧} --> 抓帧",
      "抓帧 --> url:https://example.com/profiler",
    ].join("\n"),
  },
  {
    name: "汇合结构（验证连线不会回折）",
    source: ["入口 --> 分支A", "入口 --> 分支B", "分支A --> 汇合", "分支B --> 汇合", "汇合 --> 出口"].join(
      "\n",
    ),
  },
  {
    name: "长标签与中文（验证列宽自适应）",
    source: [
      "这个节点的标签相当长 --> 短",
      '短 --> 顶点着色器与片元着色器的分工["顶点着色器计算位置，片元着色器决定颜色"]',
      "A & B --> <script>alert(1)</script>",
    ].join("\n"),
  },
  {
    name: "孤立节点与环（验证不会死循环）",
    source: ["X", "Y", "A --> B", "B --> C", "C --> A"].join("\n"),
  },
  {
    name: "写错的语法（验证警告而不是整图作废）",
    source: ["A --> B", 'C["括号没闭合 --> D', "E"].join("\n"),
  },
];

/** 复用应用自身的样式，保证"示例 = 应用" */
function readAppStyles() {
  const css = readFileSync(path.resolve(process.cwd(), "src", "app", "globals.css"), "utf8");
  // Tailwind 的 @import 与 @theme 在离线 HTML 里没法编译，只取纯 CSS 部分
  return css
    .replace(/@import[^;]+;/g, "")
    .replace(/@theme\s*\{[\s\S]*?\n\}/, "")
    .replace(/^\s*--color-[\w-]+:.*$/gm, "");
}

const sections = SAMPLES.map((sample) => {
  const { svg, spec } = renderDiagram(sample.source, resolveDiagramLink);
  const warnings =
    spec.warnings.length > 0
      ? `<ul class="warn">${spec.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`
      : `<p class="ok">无警告</p>`;

  return `
  <section>
    <h2>${escapeHtml(sample.name)}</h2>
    <pre class="src">${escapeHtml(sample.source)}</pre>
    <div class="nodes-diagram frame">${svg}</div>
    <p class="meta">${spec.nodes.length} 节点 · ${spec.edges.length} 连线</p>
    ${warnings}
  </section>`;
}).join("\n");

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>图表渲染核对</title>
<style>
${readAppStyles()}

/* 下面是这个核对页自己的布局，不影响图表本身 */
body { padding: 24px; overflow: auto; }
h1 { font-size: 16px; margin-bottom: 4px; }
.lead { color: var(--nodes-ink-faint, #6b7280); font-size: 12px; margin-bottom: 20px; }
section { margin-bottom: 28px; }
h2 { font-size: 13px; color: #98a2b3; margin-bottom: 8px; font-weight: 600; }
.src { background: #12151a; border: 1px solid #23282f; border-radius: 8px;
       padding: 8px 10px; font-size: 11px; color: #98a2b3; overflow-x: auto;
       font-family: ui-monospace, monospace; white-space: pre; }
.frame { background: #0f1216; border: 1px solid #23282f; border-radius: 10px;
         padding: 10px; margin: 8px 0; display: inline-block; max-width: 100%; }
.meta { font-size: 10px; color: #6b7280; font-family: ui-monospace, monospace; }
.ok { font-size: 10px; color: #3ddc97; }
.warn { list-style: none; padding: 0; margin: 0; }
.warn li { font-size: 10px; color: #f5b544; }
.warn li::before { content: "⚠ "; }
</style>
</head>
<body>
  <h1>图表渲染核对</h1>
  <p class="lead">
    由 scripts/diagram-preview.mjs 用与 Next 应用相同的渲染器与样式生成。
    请核对：节点是否重叠、长标签是否被裁切、可点节点是否为青色描边、
    hover 是否变亮、中文字体是否正常。带 <code>doc:</code> 的节点 href 形如
    <code>?doc=…</code>，在应用里点击会切换文档。
  </p>
${sections}
</body>
</html>
`;

writeFileSync(outPath, html, "utf8");

// 顺带把关键结构打到控制台，便于在没有浏览器时也能核对
const totalSvg = SAMPLES.map((s) => renderDiagram(s.source, resolveDiagramLink).svg).join("");
const anchors = totalSvg.match(/<a href="[^"]*"/g) ?? [];
console.log(`已写出：${outPath}`);
console.log(`  大小：${(Buffer.byteLength(html, "utf8") / 1024).toFixed(1)} KB`);
console.log(`  可点击节点：${anchors.length} 个`);
for (const anchor of anchors.slice(0, 6)) console.log(`    ${anchor}`);
console.log(`  带 ?doc= 的链接：${(totalSvg.match(/\?doc=/g) ?? []).length} 处`);

/* ------------------------------------------------------------------ *
 * 几何核对
 *
 * 这一组检查的是"人眼一眼能看出、但字符串断言看不见"的问题：
 * 节点互相盖住、节点跑出画布被裁掉、可点区域小到点不中。
 * 布局是手写的，所以这些是它最可能出的错。
 * ------------------------------------------------------------------ */

let geometryProblems = 0;

for (const sample of SAMPLES) {
  const { layout } = renderDiagram(sample.source, resolveDiagramLink);
  const problems = [];

  // 1) 节点互相重叠
  for (let i = 0; i < layout.nodes.length; i += 1) {
    for (let j = i + 1; j < layout.nodes.length; j += 1) {
      const a = layout.nodes[i];
      const b = layout.nodes[j];
      const overlapX = a.x < b.x + b.width && b.x < a.x + a.width;
      const overlapY = a.y < b.y + b.height && b.y < a.y + a.height;
      if (overlapX && overlapY) problems.push(`节点重叠：${a.id} 与 ${b.id}`);
    }
  }

  // 2) 跑出画布（会被 viewBox 裁掉，用户直接看不到）
  for (const node of layout.nodes) {
    if (node.x < 0 || node.y < 0) problems.push(`节点坐标为负：${node.id}`);
    if (node.x + node.width > layout.width) problems.push(`节点横向溢出：${node.id}`);
    if (node.y + node.height > layout.height) problems.push(`节点纵向溢出：${node.id}`);
  }

  // 3) 点击热区 —— 太小的目标在触控板上很难点中
  const MIN_TARGET = 28;
  for (const node of layout.nodes) {
    if (node.width < MIN_TARGET || node.height < MIN_TARGET) {
      problems.push(`节点热区过小：${node.id} (${node.width}×${node.height})`);
    }
  }

  // 4) 同列节点必须纵向不重叠且保持顺序（分层图可读性的底线）
  const byX = new Map();
  for (const node of layout.nodes) {
    const list = byX.get(node.x) ?? [];
    list.push(node);
    byX.set(node.x, list);
  }
  for (const [, column] of byX) {
    column.sort((a, b) => a.y - b.y);
    for (let i = 1; i < column.length; i += 1) {
      if (column[i].y < column[i - 1].y + column[i - 1].height) {
        problems.push(`同列纵向重叠：${column[i - 1].id} 与 ${column[i].id}`);
      }
    }
  }

  if (problems.length > 0) {
    geometryProblems += problems.length;
    console.log(`  ✖ ${sample.name}`);
    for (const p of problems) console.log(`      ${p}`);
  } else {
    console.log(`  ✔ ${sample.name}（布局无重叠、无溢出、热区充足）`);
  }
}

console.log(
  geometryProblems === 0
    ? "\n几何核对通过。"
    : `\n几何核对发现 ${geometryProblems} 个问题。`,
);

if (geometryProblems > 0) process.exitCode = 1;
