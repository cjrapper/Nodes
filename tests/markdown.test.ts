/**
 * 客户端 Markdown 渲染器的测试。
 *
 * 这里保护两件事：
 *  1. **安全**：笔记正文是不可信输入，任何一条 XSS 断言挂掉都是线上事故。
 *  2. **语法覆盖**：知识块类型（heading / code / quote / list / todo / table）
 *     都要能在客户端被正确渲染，否则服务端切好块、前端却显示成源码。
 *
 * 断言刻意"宽松 + 精确"混用：结构用 assert.match 检查片段（避免测试被
 * Tailwind class 的微调搞红），安全与语义用 assert.equal 精确检查。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { escapeHtml, renderInline, renderMarkdownToHtml } from "../src/lib/render/markdown.ts";

/**
 * 渲染器允许生成的标签。任何超出这份名单的标签都意味着逃逸被绕过。
 *
 * `img` / `figure` / `figcaption` 是图片功能引入的，加进来之前请确认：
 * 渲染器**永远**不会用用户输入拼标签名，只会在固定的几个位置输出它们。
 */
const ALLOWED_TAGS =
  /^<\/?(p|h[1-6]|ul|ol|li|strong|em|del|code|pre|blockquote|hr|table|thead|tbody|tr|th|td|div|span|a|input|br|img|figure|figcaption)\b/;

/**
 * 审计输出里的所有标签：必须全部落在白名单内。
 *
 * 这是整套安全测试的核心断言 —— 逐个子串检查（`html.includes("<img")`）很容易
 * 假阳性（`&lt;img` 里也含 `<img`），而"标签白名单"是精确的：
 * 用户写的东西只可能以 `&lt;` 开头，压根进不了这个正则的匹配结果。
 */
function auditTags(html: string): boolean {
  const tags = html.match(/<\/?[a-zA-Z][^>]*>/g) ?? [];
  return tags.every((tag) => ALLOWED_TAGS.test(tag));
}

/**
 * 标签内的属性结构是否完好 —— 用来抓"属性被用户输入闭合"这类注入。
 *
 * ## 为什么不能只写 `/onerror=/i.test(html)`
 *
 * 第一版就是这么写的，结果一条**正确**的输出被判红：
 * 输入 `![a" onerror="alert(1)](asset:…)` 时，渲染器把 alt 里的 `"` 转义成
 * `&quot;`，输出里确实出现了 `onerror=` 这几个字符，但它**在引号内部**，
 * 是纯文本、不可能成为属性：
 *
 *     alt="a&quot; onerror=&quot;alert(1)"
 *
 * 假失败比假通过更危险（一个总在误报的检查会让人学会忽略它），所以判据
 * 必须落在真正的安全性质上，而不是"输出里有没有这几个字符"。
 *
 * ## 判据：引号配平
 *
 * 输出里每个 `"` 都必须是渲染器自己写的定界符 —— 用户输入在入口就被转义成
 * `&quot;`，不可能贡献一个裸引号。所以：
 *
 *  - 标签里 `"` 的个数必须是偶数；
 *  - 且引号**一定成对**（不是 `"a"b"c` 这种交叉形态）。
 *
 * 属性注入必然打破其中一条：要闭合 `alt="…`，攻击者就得贡献一个裸引号，
 * 那正是渲染器绝不会输出的东西。这条性质可证、且不会误报。
 *
 * ⚠️ 曾经还写了一条"引号之外不得出现 `name=`"的判据，那是**错的** ——
 * 合法 HTML 里属性名本来就在引号外面（`<img src="…" alt="…" />`），
 * 那条会把每个正常标签都判红。删掉了，不保留"看起来更严格"的假检查。
 */
function auditAttributes(html: string): { ok: boolean; reason: string } {
  // 只审计我们自己生成的标签：`<` 已被全部转义，能匹配到的都是渲染器输出的
  const tags = html.match(/<[a-zA-Z][^>]*>/g) ?? [];

  for (const tag of tags) {
    const quotes = (tag.match(/"/g) ?? []).length;
    if (quotes % 2 !== 0) {
      return { ok: false, reason: `标签引号不配平（${quotes} 个）：${tag}` };
    }
    // 成对但交叉（`"a"b"c"` 之外还有裸露的引号边界）也会被上面抓住；
    // 这里再确认引号区段不重叠 —— 用交替匹配消耗，残余引号即异常
    const residual = tag.replace(/="[^"]*"/g, "");
    if (residual.includes('"')) {
      return { ok: false, reason: `存在不属于属性值的引号：${tag}` };
    }
  }
  return { ok: true, reason: "" };
}

/* ------------------------------------------------------------------ *
 * 1. XSS
 * ------------------------------------------------------------------ */

test("<script> 标签被转义，不会出现在输出里", () => {
  const html = renderMarkdownToHtml("<script>alert(1)</script>");
  assert.equal(html.includes("<script"), false, "绝不能输出可执行的 script 标签");
  assert.equal(html.includes("</script>"), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  // <p> 包裹时的形态
  assert.match(html, /^<p class="[^"]*">/);
});

test("javascript: 链接降级为纯文本，不产生 href", () => {
  const html = renderMarkdownToHtml("[点我](javascript:alert(1))");
  assert.equal(html.includes("href="), false, "不安全协议不得生成 href 属性");
  assert.equal(html.includes("<a "), false, "不安全协议不得生成 <a>");
  // 降级后原文仍需可见（用户应该看到"这是个坏链接"而不是凭空少一段）
  assert.match(html, /\[点我\]\(javascript:alert\(1\)\)/);
});

test("大小写 / 空白 / 控制字符伪装的 javascript: 一律被拒", () => {
  const attacks = [
    "[x](JavaScript:alert(1))",
    "[x](JAVASCRIPT:alert(1))",
    "[x](  javascript:alert(1))",
    "[x](java\tscript:alert(1))",
    "[x](java\nscript:alert(1))",
    "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[x](vbscript:msgbox(1))",
    "[x](file:///etc/passwd)",
    // 协议相对地址：取不出协议，按约定一并拒绝
    "[x](//evil.example.com)",
  ];
  for (const attack of attacks) {
    const html = renderMarkdownToHtml(attack);
    assert.equal(html.includes("href="), false, `不该生成 href: ${attack}`);
    // 注意：断言"整段输出里没有 javascript:" 是错的 —— 降级后的**纯文本**本来
    // 就包含这几个字（这正是降级的含义）。因此只审计真正写进属性里的值。
    const href = /href="([^"]*)"/.exec(html)?.[1] ?? "";
    assert.equal(/javascript\s*:/i.test(href), false, `href 里不该有 javascript: ${attack}`);
  }
});

test("实体二次解码攻击（&colon;）不产生 javascript href", () => {
  // 若只做"取协议 → 白名单"而放过 `&`，浏览器会把 &amp; 解回 & 再拼成
  // javascript:alert(1) 执行。实体形态的 & 因此一律拒收。
  const html = renderMarkdownToHtml("[x](javascript&colon;alert(1))");
  assert.equal(html.includes("href="), false);
  assert.match(html, /\[x\]\(javascript&amp;colon;alert\(1\)\)/, "降级为纯文本且 & 已转义");

  // 十六进制数字引用是同一个洞的另一种写法
  const hex = renderMarkdownToHtml("[x](javascript&#x3a;alert(1))");
  assert.equal(hex.includes("href="), false);
});

test("安全的 http/https/mailto 链接保留，外链带 noopener", () => {
  // 查询串里的 & 必须被转义一次（且只一次）成 &amp;
  const ext = renderMarkdownToHtml("[官网](https://example.com/a?b=1&c=2)");
  assert.match(ext, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2"/, "& 必须转义成 &amp;");
  assert.match(ext, /target="_blank"/);
  assert.match(ext, /rel="noopener noreferrer"/);

  const mail = renderMarkdownToHtml("[发信](mailto:a@b.com)");
  assert.match(mail, /href="mailto:a@b\.com"/);
  assert.equal(mail.includes("target="), false, "mailto 不该强行 new tab");

  const http = renderMarkdownToHtml("[内网](http://10.0.0.1:3210/doc)");
  assert.match(http, /href="http:\/\/10\.0\.0\.1:3210\/doc"/);
});

test("img / iframe / svg 等标签形态被彻底转义", () => {
  const html = renderMarkdownToHtml('<img src=x onerror="alert(1)">\n\n<iframe src="//evil"></iframe>');
  // 必须用"真实标签"形态断言：`<img` 这种子串在 `&lt;img` 里也会命中，会产生假阳性
  assert.equal(/<img[\s/>]/.test(html), false);
  assert.equal(/<iframe[\s/>]/.test(html), false);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  // 整段输出的标签白名单审计：`onerror=` 出现在纯文本里无害（引号已转义），
  // 真正要保证的是"没有任何我没生成的标签"。详见最后一个测试的同一套审计。
  assert.equal(auditTags(html), true, "只允许渲染器自己生成的标签");
});

test("属性注入：正文里的引号无法闭合 class", () => {
  const html = renderMarkdownToHtml('# 标题 " onmouseover="alert(1)');
  assert.equal(html.includes('onmouseover="'), false);
  assert.match(html, /&quot; onmouseover=&quot;alert\(1\)/);
});

test("escapeHtml 的替换顺序不会造成二次转义", () => {
  // 若先替换 < 再替换 &，`<` 会变成 `&amp;lt;`，页面上显示成 &lt; 字面量
  assert.equal(escapeHtml("<"), "&lt;");
  assert.equal(escapeHtml("&"), "&amp;");
  assert.equal(escapeHtml("<a & b>"), "&lt;a &amp; b&gt;");
  assert.equal(escapeHtml('"x"'), "&quot;x&quot;");
});

/* ------------------------------------------------------------------ *
 * 2. 代码块：内部完全不解析
 * ------------------------------------------------------------------ */

test("围栏代码块内部的 # 标题与 **粗体** 不被解析", () => {
  const html = renderMarkdownToHtml("```\n# 这是标题\n**粗体**\n- 列表\n</script>\n```");
  assert.equal(html.includes("<h1"), false, "代码里的 # 不该变成标题");
  assert.equal(html.includes("<strong"), false, "代码里的 ** 不该变成粗体");
  assert.equal(html.includes("<li"), false, "代码里的 - 不该变成列表");
  assert.equal(html.includes("<script"), false);
  assert.match(html, /<pre class="[^"]*"><code[^>]*># 这是标题\n\*\*粗体\*\*\n- 列表\n&lt;\/script&gt;<\/code><\/pre>/);
});

test("带语言的围栏输出 language-xxx class", () => {
  const html = renderMarkdownToHtml("```ts\nconst a: number = 1;\n```");
  assert.match(html, /<pre class="[^"]*">/);
  assert.match(html, /<code class="[^"]*language-ts">/);
  assert.match(html, /const a: number = 1;/);
});

test("无语言围栏照常渲染，且不出现 language- class", () => {
  const html = renderMarkdownToHtml("```\nplain\n```");
  assert.equal(html.includes("language-"), false);
  assert.match(html, /<code[^>]*>plain<\/code>/);
});

test("未闭合的围栏把剩余内容当代码，不丢用户内容", () => {
  const html = renderMarkdownToHtml("```py\nprint(1)\nprint(2)");
  assert.match(html, /print\(1\)\nprint\(2\)/);
  // 注意是 `<p `（带空格）：`<pre` 也以 `<p` 开头，写 includes("<p") 会假阳性
  assert.equal(html.includes("<p "), false, "未闭合时后续行不该被当成段落");
});

/* ------------------------------------------------------------------ *
 * 3. 块级语法
 * ------------------------------------------------------------------ */

test("ATX 标题 1~6 级都渲染成对应标签", () => {
  const md = "# 一级\n\n## 二级\n\n### 三级\n\n#### 四级\n\n##### 五级\n\n###### 六级";
  const html = renderMarkdownToHtml(md);
  for (let level = 1; level <= 6; level += 1) {
    assert.match(html, new RegExp(`<h${level} class="[^"]*">`), `缺少 h${level}`);
  }
  assert.match(html, /<h1[^>]*>一级<\/h1>/);
  // 闭合井号应被去掉
  assert.match(renderMarkdownToHtml("## 标题 ##"), /<h2[^>]*>标题<\/h2>/);
});

test("表格渲染出 thead/tbody 与对齐 class", () => {
  const md = ["| 名称 | 数量 | 备注 |", "| :--- | ---: | :---: |", "| 苹果 | 3 | 红 |", "| 梨 | 12 | 绿 |"].join(
    "\n",
  );
  const html = renderMarkdownToHtml(md);
  assert.match(html, /<table class="[^"]*">/);
  assert.match(html, /<thead><tr>/);
  assert.match(html, /<tbody>/);
  assert.match(html, /<th class="[^"]*text-left[^"]*">名称<\/th>/);
  assert.match(html, /<th class="[^"]*text-right[^"]*">数量<\/th>/);
  assert.match(html, /<th class="[^"]*text-center[^"]*">备注<\/th>/);
  assert.match(html, /<td class="[^"]*">苹果<\/td>/);
  // 两行数据 → 两个 tr
  assert.equal(html.match(/<tr>/g)?.length, 3, "1 个表头行 + 2 个数据行");
});

test("表格单元格里的行内语法生效", () => {
  const html = renderMarkdownToHtml("| 列 |\n| --- |\n| **粗** |");
  assert.match(html, /<td class="[^"]*"><strong class="[^"]*">粗<\/strong><\/td>/);
});

test("孤立的竖线文本不会被当成表格", () => {
  const html = renderMarkdownToHtml("a | b | c\n没有分隔行");
  assert.equal(html.includes("<table"), false);
  assert.match(html, /^<p class="[^"]*">a \| b \| c/);
});

test("引用支持多行，并递归渲染内部块", () => {
  const html = renderMarkdownToHtml("> 第一行\n> 第二行\n> - 列表项");
  assert.match(html, /<blockquote class="[^"]*">/);
  assert.match(html, /<p class="[^"]*">第一行<br \/>第二行<\/p>/);
  assert.match(html, /<ul class="[^"]*"><li class="[^"]*">列表项<\/li><\/ul>/);

  const nested = renderMarkdownToHtml("> # 引用里的标题");
  assert.match(nested, /<blockquote[^>]*><h1 class="[^"]*">引用里的标题<\/h1><\/blockquote>/);
});

test("水平线渲染成 hr", () => {
  assert.match(renderMarkdownToHtml("---"), /^<hr class="[^"]*" \/>$/);
  assert.match(renderMarkdownToHtml("***"), /<hr class="[^"]*" \/>/);
  assert.match(renderMarkdownToHtml("___"), /<hr class="[^"]*" \/>/);
});

test("段落之间用空行分隔，行内换行渲染成 br", () => {
  const html = renderMarkdownToHtml("第一段\n\n第二段\n第二段续行");
  assert.equal(html.match(/<p class=/g)?.length, 2);
  assert.match(html, /第二段<br \/>第二段续行/);
});

/* ------------------------------------------------------------------ *
 * 4. 列表
 * ------------------------------------------------------------------ */

test("无序列表与有序列表各自渲染成 ul / ol", () => {
  const ul = renderMarkdownToHtml("- 甲\n- 乙\n- 丙");
  assert.match(ul, /<ul class="[^"]*list-disc[^"]*">/);
  assert.equal(ul.match(/<li class=/g)?.length, 3);

  const ol = renderMarkdownToHtml("1. 一\n2. 二");
  assert.match(ol, /<ol class="[^"]*list-decimal[^"]*">/);
  assert.equal(ol.match(/<li class=/g)?.length, 2);

  // * 与 + 也当无序标记
  assert.match(renderMarkdownToHtml("* 星"), /<ul class="[^"]*">/);
  assert.match(renderMarkdownToHtml("+ 加"), /<ul class="[^"]*">/);
});

test("嵌套列表（缩进 2 空格）渲染成 li 内部的子列表", () => {
  const html = renderMarkdownToHtml("- 父项一\n  - 子项 A\n  - 子项 B\n- 父项二");
  assert.equal(html.match(/<ul class="[^"]*">/g)?.length, 2, "应有外层与内层两个 ul");
  // 子列表必须落在父 li 内部
  assert.match(html, /<li class="[^"]*">父项一<ul class="[^"]*">/);
  assert.match(html, /<li class="[^"]*">子项 A<\/li><li class="[^"]*">子项 B<\/li><\/ul><\/li>/);
  // 父项二回到外层，不能被塞进内层
  assert.match(html, /<\/ul><\/li><li class="[^"]*">父项二<\/li><\/ul>$/);
});

test("混排列表在同级拆成两个列表，保持 HTML 合法", () => {
  const html = renderMarkdownToHtml("- 无序\n1. 有序");
  assert.match(html, /<\/ul><ol class="[^"]*">/);
});

test("任务列表输出禁用 checkbox，勾选状态正确", () => {
  const html = renderMarkdownToHtml("- [ ] 未完成的事\n- [x] 已完成的事\n- [X] 大写也算完成");
  assert.equal(html.match(/<input type="checkbox" disabled/g)?.length, 3);
  assert.equal(html.match(/checked/g)?.length, 2, "只有 [x] / [X] 两项带 checked");
  assert.match(html, /<input type="checkbox" disabled class="[^"]*" \/><span[^>]*>未完成的事<\/span>/);
  assert.match(
    html,
    /<input type="checkbox" disabled checked class="[^"]*" \/><span[^>]*>已完成的事<\/span>/,
  );
  // 任务项所在 li 用 flex 布局让 checkbox 与文字对齐
  assert.match(html, /<li class="[^"]*flex[^"]*">/);
});

test("普通列表项不会被误判成任务项", () => {
  const html = renderMarkdownToHtml("- 普通项");
  assert.equal(html.includes("<input"), false);
  assert.match(html, /<li class="[^"]*">普通项<\/li>/);
});

test("列表项的缩进续行归入同一个 li", () => {
  const html = renderMarkdownToHtml("- 第一行\n  续行文字\n- 第二项");
  assert.equal(html.match(/<li class=/g)?.length, 2, "续行不该产生新的 li");
  assert.match(html, /第一行<br \/>续行文字/);
});

/* ------------------------------------------------------------------ *
 * 5. 行内语法
 * ------------------------------------------------------------------ */

test("行内代码里的内容不触发其他行内语法", () => {
  const html = renderMarkdownToHtml("`**不是粗体**` 与 `[不是链接](https://x.com)`");
  assert.equal(html.includes("<strong"), false);
  assert.equal(html.includes("<a "), false, "代码里的链接语法不该生效");
  assert.match(html, /<code class="[^"]*">\*\*不是粗体\*\*<\/code>/);
  assert.match(html, /<code class="[^"]*">\[不是链接\]\(https:\/\/x\.com\)<\/code>/);
});

test("行内代码与粗体、斜体混排", () => {
  const html = renderMarkdownToHtml("**粗** 与 `code` 与 *斜*");
  assert.match(html, /<strong class="[^"]*">粗<\/strong>/);
  assert.match(html, /<em class="[^"]*">斜<\/em>/);
  assert.match(html, /<code class="[^"]*">code<\/code>/);
  // 顺序必须保持原文顺序
  const iStrong = html.indexOf("<strong");
  const iCode = html.indexOf("<code");
  const iEm = html.indexOf("<em");
  assert.ok(iStrong < iCode && iCode < iEm, "行内标签顺序应与原文一致");
});

test("粗体可以嵌套斜体，反之亦然", () => {
  const html = renderMarkdownToHtml("**粗 *粗斜* 粗**");
  assert.match(html, /<strong class="[^"]*">粗 <em class="[^"]*">粗斜<\/em> 粗<\/strong>/);
});

test("删除线渲染成 del", () => {
  const html = renderMarkdownToHtml("~~删掉了~~");
  assert.match(html, /<del class="[^"]*">删掉了<\/del>/);
});

test("行内代码里的 HTML 被转义", () => {
  const html = renderMarkdownToHtml("`<script>alert(1)</script>`");
  assert.equal(html.includes("<script"), false);
  assert.match(html, /<code class="[^"]*">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code>/);
});

test("反斜杠可以转义行内标记", () => {
  const html = renderMarkdownToHtml("\\*不是斜体\\* 和 \\`不是代码\\`");
  assert.equal(html.includes("<em"), false, "转义后的星号不该变成斜体");
  assert.equal(html.includes("<code"), false, "转义后的反引号不该变成行内代码");
  assert.match(html, /\*不是斜体\*/);
  assert.match(html, /`不是代码`/);
});

test("snake_case 不被误伤成斜体", () => {
  const html = renderMarkdownToHtml("变量 user_id 与 order_id 都不该变斜体");
  assert.equal(html.includes("<em"), false);
});

test("落单的星号 / 反引号原样输出", () => {
  assert.match(renderMarkdownToHtml("5 * 3 = 15"), /5 \* 3 = 15/);
  assert.match(renderMarkdownToHtml("一个 ` 反引号"), /一个 ` 反引号/);
});

test("renderInline 遵守「入参已逃逸」的约定，且同输入同输出", () => {
  // renderInline 是内部约定的低层入口：入参必须已经过 escapeHtml（见其文档注释）。
  // 直接喂原文会把 `&` 再逃逸一次，所以用 escapeHtml 走一遍。
  const input = "**粗** 与 `code`";
  const once = renderInline(escapeHtml(input));
  assert.equal(renderInline(escapeHtml(input)), once, "同输入必须同输出");
  assert.match(once, /<strong/);
  assert.match(once, /<code/);
  // 逃逸态输入里的 &amp; 不会被二次逃逸
  assert.equal(renderInline("a &amp; b"), "a &amp; b");
});

/* ------------------------------------------------------------------ *
 * 6. 边界与健壮性
 * ------------------------------------------------------------------ */

test("空输入不崩且输出空串", () => {
  assert.equal(renderMarkdownToHtml(""), "");
  assert.equal(renderInline(""), "");
});

test("只有空白 / 换行的输入不产生任何块", () => {
  assert.equal(renderMarkdownToHtml("   \n\n\t\n").trim(), "");
  assert.equal(renderMarkdownToHtml("\n").trim(), "");
});

test("CRLF 换行与 BOM 同样能正确识别标题", () => {
  assert.match(renderMarkdownToHtml("# 标题\r\n\r\n正文\r\n"), /<h1[^>]*>标题<\/h1>/);
  assert.match(renderMarkdownToHtml("\uFEFF# 带 BOM 的标题"), /<h1[^>]*>带 BOM 的标题<\/h1>/);
});

test("无法归类的行不会导致死循环（兜底为段落）", () => {
  // `###` 后面没有空格不是标题；`&gt;` 之前的老式引用也不是；应落到段落
  const html = renderMarkdownToHtml("###\n正文");
  assert.match(html, /<p class="[^"]*">###<br \/>正文<\/p>/);
});

test("渲染结果不含任何未转义的用户标签（模糊测试式抽样）", () => {
  const evil = [
    "<ScRiPt>alert(1)</ScRiPt>",
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    "[[[[[[[[[[",
    "]]]]]]]]]]",
    "((((((((((",
    "`".repeat(20),
    "*".repeat(20),
    "|".repeat(20),
    ">".repeat(20),
    "&".repeat(20),
    "- ".repeat(20),
    "#".repeat(20),
    "\u0000\u0001\u0002",
  ].join("\n\n");
  const html = renderMarkdownToHtml(evil);
  assert.ok(html.length > 0, "不应该整段消失");
  assert.equal(auditTags(html), true, "输出里只能有渲染器自己生成的标签");
  assert.equal(/href="javascript/i.test(html), false);
});

/* ------------------------------------------------------------------ *
 * 12. 图片
 *
 * 图片是渲染器里**唯一会把用户输入写进 src 属性**的地方，所以这一节
 * 的每一条都是安全断言，不只是功能断言。
 * ------------------------------------------------------------------ */

const VALID_ASSET = "asset:" + "a".repeat(64) + ".png";

test("asset: 引用渲染成图片，src 指向素材接口", () => {
  const html = renderMarkdownToHtml(`![判定框](${VALID_ASSET})`);
  assert.match(html, /<img /);
  assert.ok(html.includes(`src="/api/assets/${"a".repeat(64)}.png"`));
  assert.equal(auditTags(html), true);
});

test("说明文字原样进 alt，且可见地渲染出来", () => {
  const html = renderMarkdownToHtml(`![受击判定框 12帧](${VALID_ASSET})`);
  assert.match(html, /alt="受击判定框 12帧"/);
  assert.match(html, />受击判定框 12帧<\/span>/, "说明文字要可见，不能只藏在 alt 里");
});

test("说明文字里的引号无法闭合 alt 属性", () => {
  /*
   * 攻击目标：如果 alt 没做属性转义，这里的 `"` 会闭合 alt 并注入 onerror。
   *
   * 判据是**对比**：
   *  - 输出里出现的是转义形态 `&quot;`（说明引号被处理过）；
   *  - 引号配平，没有"逃逸出属性值"的裸引号。
   * 只看 `/onerror=/` 会误报 —— 已转义的 `onerror=&quot;` 是纯文本，无害。
   */
  const html = renderMarkdownToHtml(`![a" onerror="alert(1)](${VALID_ASSET})`);

  assert.ok(html.includes("&quot;"), "引号必须被转义");
  const audit = auditAttributes(html);
  assert.equal(audit.ok, true, audit.reason);
  assert.equal(auditTags(html), true);

  // 关键对比：用户的引号**只**以实体形态出现，绝不作为裸引号出现在输出里。
  // 裸引号只可能是渲染器自己的定界符，数一下就知道有没有多余的一个。
  const rawQuotes = (html.match(/"/g) ?? []).length;
  assert.equal(rawQuotes % 2, 0, "裸引号必须成对（多余的一个意味着属性被闭合）");
});

test("图片不会被塞进 <p> 里 —— 块级元素嵌套会让浏览器把段落截断", () => {
  /*
   * 这条来自真实 bug：第一版用 `<figure>` 做图片外层，于是"图文混排"
   * 会输出 `<p>看图：<figure>…</figure> 就是这样</p>`。
   * `<figure>` 是块级元素，HTML 解析器遇到 `<p><figure>` 会**隐式闭合 <p>**，
   * 用户的一句话被切成好几段，还会留下一串空 `<p>`。
   *
   * 判据：图片外层必须是行内元素（span），且绝不能出现在 `<p>` 内部。
   */
  const mixed = renderMarkdownToHtml(`看图：![说明](${VALID_ASSET}) 就是这样`);
  assert.match(mixed, /<span[^>]*><a [^>]*><img /, "图片外层应当是行内元素");

  // 段落里出现块级标签即为非法嵌套
  for (const blockTag of ["figure", "figcaption", "div", "p", "table", "pre", "blockquote"]) {
    const bad = new RegExp(`<p[^>]*>(?:(?!</p>).)*<${blockTag}\\b`, "s");
    assert.equal(bad.test(mixed), false, `段落里不能出现块级 <${blockTag}>`);
  }
});

test("data: 图片被拒绝 —— 它是标准的 XSS 载体", () => {
  const html = renderMarkdownToHtml("![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)");
  assert.equal(html.includes("<img"), false, "data: 不该渲染成图片");
  assert.equal(/src\s*=\s*"data:/i.test(html), false);
});

test("javascript: 图片目标被拒绝", () => {
  const html = renderMarkdownToHtml("![x](javascript:alert(1))");
  assert.equal(html.includes("<img"), false);
});

test("协议相对地址（//host）被拒绝 —— 取不出协议就无法判断安全性", () => {
  const html = renderMarkdownToHtml("![x](//evil.example.com/a.png)");
  assert.equal(html.includes("<img"), false);
});

test("坏掉的素材 id 降级为纯文本，不产生坏图", () => {
  const html = renderMarkdownToHtml("![图](asset:../../etc/passwd)");
  assert.equal(html.includes("<img"), false, "非法 id 不能变成 src");
  assert.match(html, /asset:\.\.\/\.\.\/etc\/passwd/, "应当把用户写的内容原样显示出来");
});

test("非图片扩展名的素材 id 被拒绝 —— 与 store.ts 的判据必须一致", () => {
  // 这条是**同步测试**：store.ts 的 ASSET_ID_RE 收窄成图片扩展名白名单后，
  // 渲染器里那份重复实现必须跟着收窄，否则会出现
  // "渲染器放行、接口取不到"（或更糟的"渲染器放行了本该拒绝的 id"）的分裂。
  for (const bad of [`asset:${"a".repeat(64)}.php`, `asset:${"a".repeat(64)}.html`, `asset:${"a".repeat(64)}.svg`]) {
    const html = renderMarkdownToHtml(`![图](${bad})`);
    assert.equal(html.includes("<img"), false, `不能放行：${bad}`);
  }
});

test("http(s) 外链图仍然可以渲染，包括带查询参数的地址", () => {
  const https = renderMarkdownToHtml("![远程](https://cdn.example.com/a.png)");
  assert.match(https, /<img /);
  assert.ok(https.includes('src="https://cdn.example.com/a.png"'));

  // 查询串里的 & 在入口被逃逸成 &amp;，位置在冒号之后，必须放行
  const query = renderMarkdownToHtml("![远程](https://cdn.example.com/a.png?w=100&h=50)");
  assert.match(query, /<img /, "带查询参数的图床地址不能被误杀");
  assert.ok(query.includes("w=100&amp;h=50"));
});

test("mailto: 不会被当成图片（它只在链接语义下合法）", () => {
  const html = renderMarkdownToHtml("![邮件](mailto:a@b.com)");
  assert.equal(html.includes("<img"), false);
});

test("图片独占一段时不会被行内语法吃掉前面的感叹号", () => {
  // `!` 在普通文本里必须原样保留：`这是重点！` 不能被当成图片起始
  const html = renderMarkdownToHtml("这是重点！\n\n还有 ! 这种半角感叹号");
  assert.equal(html.includes("<img"), false);
  assert.match(html, /这是重点！/);
  assert.match(html, /还有 ! 这种半角感叹号/);
});

test("落单的 ![ 不吞内容", () => {
  const html = renderMarkdownToHtml("![没有右括号");
  assert.match(html, /!\[没有右括号/);
});

test("图片和文字混排在同一段里也能渲染", () => {
  const html = renderMarkdownToHtml(`看图：![说明](${VALID_ASSET}) 就是这样`);
  assert.match(html, /<img /);
  assert.match(html, /看图：/);
  assert.match(html, /就是这样/);
  assert.equal(auditTags(html), true);
});
