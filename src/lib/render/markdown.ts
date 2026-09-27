/**
 * 客户端 Markdown 渲染器（零依赖）。
 *
 * 为什么不用 marked / markdown-it / remark：
 *  - 笔记内容是不可信输入，第三方渲染器默认允许内联 HTML，必须再叠一个 sanitizer；
 *    这里从头写反而更容易把"逃逸"这件事做对、做全。
 *  - 本项目需要的语法子集是可控的（见 `blocks/markdown.ts` 里 parseMarkdown 支持的块类型），
 *    不需要 CommonMark 的全部角落语义，为此引入几百 KB 依赖不划算。
 *
 * ⚠️ 与 `src/lib/blocks/markdown.ts` 的关系：**完全独立，互不 import**。
 * 那个文件是服务端的「Markdown → 知识块」切分器（关心往返无损与 cache_key 稳定性），
 * 本文件是客户端的「Markdown → HTML」渲染器（关心 XSS 与观感）。
 * 切块必须在原始字节上工作，渲染必须先逃逸再解析，两者共用代码只会让双方都难改。
 *
 * ## 安全模型（本文件最重要的一节）
 *
 * 全模块只有一个**逃逸点**：入口 renderMarkdownToHtml 里的一次 escapeHtml。
 * 顺序刻意是「整体逃逸 → 再解析 Markdown」，而不是「解析 → 渲染时逐个逃逸」：
 *
 *  1. 逃逸之后用户字节里不可能再出现 `<`，任何标签都进不了输出，
 *     XSS 面被一次性掐死，后续所有函数都不必再问"这段文本安全吗"。
 *  2. 逃逸不会破坏 Markdown 标记的定位：需要的标记字符是
 *     `# - * + ` | [ ] ( )`，全都不是 `& < > "` 中的任何一个。
 *     唯一的例外是块引用 `>` 会变成 `&gt;`，所以引用前缀的正则写的是 `&gt;`。
 *  3. 反过来（先解析、再对"文本节点"逃逸）就必须区分"我自己生成的标签"和
 *     "用户写的标签"，漏判一处即 XSS。这条路历史上出过的 CVE 数不胜数。
 *
 * 已知且有意的取舍：本模块**不是幂等的**，`render(render(x))` 会把已有实体再逃逸一次
 * （`&lt;` → `&amp;lt;`）。若为了幂等而在入口"检测是否已含实体就跳过逃逸"，
 * 那么用户原样输入的 `&lt;script&gt;` 会被误判成已逃逸并作为真实标签送进 DOM，
 * 那才是真正的 XSS 后门。渲染器只被调用一次，幂等在这里没有价值，安全有。
 */

/* ------------------------------------------------------------------ *
 * 0. 样式常量
 *
 * 深色主题 token（见 DESIGN.md）：
 *   页面 #0b0d10 · 面板 #12151a · 卡片 #171b21 · 边框 #23282f
 *   主文字 #e6e9ee · 次要 #98a2b3 · 弱化 #6b7280
 *   强调 #3ddc97 · 次强调 #f5b544 · 危险 #f2555a
 *
 * 一律用 Tailwind 任意值语法内联，不依赖 tailwind.config.ts 或 typography 插件，
 * 这样即使渲染结果出现在没有额外配置的页面里，配色也依然是对的。
 * ------------------------------------------------------------------ */

/** 六个标题级别对应的 class，索引 = level - 1 */
const HEADING_CLASS: readonly string[] = [
  "mt-6 mb-3 text-2xl font-semibold leading-tight tracking-tight text-[var(--nodes-ink)]",
  "mt-6 mb-3 text-xl font-semibold leading-tight tracking-tight text-[var(--nodes-ink)]",
  "mt-4 mb-2 text-lg font-semibold leading-snug text-[var(--nodes-ink)]",
  "mt-4 mb-2 text-base font-semibold text-[var(--nodes-ink)]",
  "mt-3 mb-1.5 text-sm font-semibold text-[var(--nodes-ink)]",
  "mt-3 mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--nodes-ink-dim)]",
];

const P_CLASS = "my-3 text-sm leading-7 text-[var(--nodes-ink)]";
const STRONG_CLASS = "font-semibold text-[var(--nodes-ink)]";
const EM_CLASS = "italic text-[var(--nodes-ink)]";
const DEL_CLASS = "text-[var(--nodes-ink-dim)] line-through decoration-[#f2555a]/70";
const CODE_CLASS = "rounded bg-[#171b21] px-1 py-0.5 font-mono text-[0.85em] text-[#3ddc97]";
const LINK_CLASS =
  "text-[#3ddc97] underline decoration-[#3ddc97]/40 underline-offset-2 hover:decoration-[#3ddc97]";
const LIST_CLASS = "my-3 space-y-1 pl-6 text-sm leading-7 text-[var(--nodes-ink)]";
const LI_CLASS = "leading-7";
const TODO_LI_CLASS = "flex items-start gap-2 leading-7";
const CHECKBOX_CLASS = "mt-[0.45rem] size-3.5 shrink-0 accent-[#3ddc97]";
const QUOTE_CLASS =
  "my-4 border-l-2 border-[#3ddc97]/50 bg-[#12151a] py-1 pl-4 pr-2 text-sm leading-7 text-[var(--nodes-ink-dim)]";
const PRE_CLASS =
  "my-4 overflow-x-auto rounded-lg border border-[#23282f] bg-black/40 p-3 text-[13px] leading-6";
const PRE_CODE_CLASS = "font-mono text-[13px] text-[var(--nodes-ink)]";
const HR_CLASS = "my-6 border-0 border-t border-[#23282f]";
const TABLE_WRAP_CLASS = "my-4 overflow-x-auto rounded-lg border border-[#23282f]";
const TABLE_CLASS = "w-full border-collapse text-left text-sm text-[var(--nodes-ink)]";
const TH_CLASS = "border-b border-[#23282f] bg-[#171b21] px-3 py-2 font-semibold text-[var(--nodes-ink)]";
const TD_CLASS = "border-b border-[#23282f] px-3 py-2 align-top text-[var(--nodes-ink)]";
/**
 * 行内图片的外层。
 *
 * ⚠️ 用 `<span>` 而不是 `<figure>`：行内解析的结果**可能被包进 `<p>`**，
 * 而 `<figure>` 是块级元素，放进 `<p>` 是非法嵌套 —— 浏览器会把 `<p>`
 * 提前闭合，于是"看图：<图> 就是这样"会渲染出三个断裂的段落和一串空标签。
 * `inline-block` + `max-w-full` 把 span 撑成图片宽度，视觉上与块级一致。
 */
const FIGURE_INLINE_CLASS = "my-1 inline-block max-w-full align-top";
const IMG_CLASS =
  "max-w-full cursor-zoom-in rounded-lg border border-[#23282f] bg-[#12151a] align-top";
const FIGCAPTION_CLASS =
  "mt-1.5 text-center text-xs leading-5 text-[var(--nodes-ink-dim)]";
/** 行内场景下说明文字要跟着图片宽度居中，所以自己也是 inline-block */
const FIGCAPTION_INLINE_CLASS = `${FIGCAPTION_CLASS} block`;

/** 表格列对齐 → Tailwind 工具类 */
const ALIGN_CLASS = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
} as const;

type Align = keyof typeof ALIGN_CLASS;

/* ------------------------------------------------------------------ *
 * 1. 逃逸
 * ------------------------------------------------------------------ */

/**
 * HTML 转义。替换顺序和字符集都是刻意的：
 *
 *  - `&` **必须第一个**替换。否则先替换 `<` 得到 `&lt;`，下一步替换 `&`
 *    会把刚生成的实体再转一遍，`<` 最终变成 `&amp;lt;` —— 用户看到的是乱码
 *    而不是内容。这就是"转义顺序"在整份实现里唯一但致命的坑。
 *  - `>` 也要转。虽然 HTML5 里裸 `>` 是合法文本，但转掉可以顺手掐死
 *    `-->`、`]]>` 这类"换一个解析上下文就有意义"的序列；代价仅仅是
 *    块引用正则要写 `&gt;`（见 QUOTE_RE），只此一处。
 *  - `"` 转成 `&quot;`：本模块所有属性值都用双引号包裹（`class="..."`），
 *    用户输入只要可能进属性就必须无法闭合引号。
 *  - `'` 不转，因为我们从不用单引号包属性；少一次替换也少一分噪声。
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ *
 * 2. 链接协议白名单
 * ------------------------------------------------------------------ */

/**
 * 只放行这四种；`javascript:` `data:` `vbscript:` `file:` 一律降级为纯文本。
 *
 * `asset:` 是本项目自己的素材协议（`asset:<sha256>.<ext>`，见
 * `lib/assets/store.ts`）。它和 http(s) 走的是**同一套**校验，
 * 不是旁路 —— 新增一个协议必须同时满足下面所有防线，尤其是
 * safeHref 第 (2) 条的"引号/尖括号一律拒绝"。
 *
 * 为什么不用 `data:`：base64 内联会把正文撑到几百 KB，每次渲染都把
 * 图片字节重新拼进 DOM；而且 `data:text/html,...` 是标准的 XSS 载体，
 * 放行 `data:` 就等于放行它 —— 白名单是按协议粒度生效的，没法只放行图片。
 */
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "asset:"]);

/**
 * 素材 id 的形状约束：`<64 位小写十六进制>.<图片扩展名>`。
 *
 * 与 `lib/assets/store.ts` 的 `ASSET_ID_RE` 是**同一个判据**，这里是客户端侧的
 * 重复实现，刻意不 import —— 渲染器要能在没有 node:crypto、
 * 没有文件系统的情况下运行（纯函数、可预渲染），而 store 模块会拉起它们。
 *
 * ⚠️ 两处必须逐字同步。判据放窄时尤其要注意：早先这里写的是
 * `[a-z0-9]{1,8}`，允许 `…php` 这种形状，而 store 侧已经收窄成
 * 图片扩展名白名单 —— 不同步就会出现"渲染器认为合法、接口取不到"
 * 或者更糟的"渲染器放行了本该拒绝的 id"。对应的回归测试在两个文件里各有一份。
 */
const ASSET_ID_RE = /^[0-9a-f]{64}\.(?:png|jpe?g|gif|webp)$/;

/** 素材协议的拼法。与 store.ts 的 `ASSET_PROTOCOL` 同值，理由同上。 */
const ASSET_PROTOCOL = "asset:";

/**
 * 文字颜色的白名单：`{名字|文字}` → Tailwind class。
 *
 * 用名字而不是色值，是刻意的安全取舍 —— 见 renderInline 里的说明。
 * 名字都支持中文与英文两种写法（会先去掉空格与下划线再匹配）。
 */
const COLOR_CLASSES: Record<string, string> = {
  red: "text-[#f2555a]",
  red2: "text-[#f2555a]",
  红: "text-[#f2555a]",
  orange: "text-[#f5b544]",
  yellow: "text-[#f5b544]",
  橙: "text-[#f5b544]",
  黄: "text-[#f5b544]",
  green: "text-[#3ddc97]",
  绿: "text-[#3ddc97]",
  blue: "text-[#6aa8ff]",
  蓝: "text-[#6aa8ff]",
  purple: "text-[#a78bfa]",
  紫: "text-[#a78bfa]",
  cyan: "text-[#2dd4bf]",
  青: "text-[#2dd4bf]",
  pink: "text-[#f472b6]",
  粉: "text-[#f472b6]",
  gray: "text-[var(--nodes-ink-dim)]",
  grey: "text-[var(--nodes-ink-dim)]",
  灰: "text-[var(--nodes-ink-dim)]",
  dim: "text-[var(--nodes-ink-faint)]",
  弱: "text-[var(--nodes-ink-faint)]",
  /** 高亮底色，用来标记"这里要背下来" */
  mark: "bg-[#f5b544]/20 px-0.5 rounded-sm",
  高亮: "bg-[#f5b544]/20 px-0.5 rounded-sm",
};

/** 供 UI 展示的颜色速查表（新增颜色时同步这里即可） */
export const COLOR_LEGEND: { name: string; label: string }[] = [
  { name: "red", label: "红 · 重点/易错" },
  { name: "orange", label: "橙 · 待确认" },
  { name: "green", label: "绿 · 已掌握" },
  { name: "blue", label: "蓝 · 术语" },
  { name: "purple", label: "紫 · 关联" },
  { name: "mark", label: "高亮 · 要背" },
];

/**
 * 「实体形态的 `&`」检测 —— 只拦真正构成走私的那种位置。
 *
 * 背景：本模块在入口就把整份输入逃逸了，所以这里的 URL 已经是**逃逸态**，
 * 用户原文里的 `&` 一定表现为 `&amp;`。
 *
 * 危险形态的**必要条件是"走私的实体出现在协议区"**：
 * 用户原文写 `javascript&colon;alert(1)`，逃逸后成了
 * `javascript&amp;colon;alert(1)`。协议检查看到 `javascript&amp;colon;` 取不出
 * 协议便以为无害；而浏览器解析属性值时会先把 `&amp;` 解回 `&`，再拼成
 * `javascript:alert(1)` 执行。这就是"实体二次解码"。
 *
 * 反过来，查询串里的 `&` 出现在**冒号之后**（`https://a.com/?b=1&c=2`
 * 逃逸成 `...?b=1&amp;c=2`），早已越过了协议区，无论解码成什么字符都
 * 不可能改变协议判定 —— 它是纯数据，必须放行。
 *
 * 早期版本没有区分位置，只要出现 `&amp;colon` 就拒绝，结果把正常的
 * `?b=1&c=2` 查询串也一起拦掉了（对应的回归测试就是
 * 「安全的 http/https/mailto 链接保留」）。这里补上"冒号之前"这个位置约束。
 *
 * 正则的两段结构：
 *  - `&amp;#` —— 数字字符引用（`&#x3a;` 是 `:` 的另一种写法），一律从严。
 *    它不要求位置约束，因为已经逃逸的查询串里 `&#` 只可能来自用户原文，
 *    而用户原文在 URL 里写 `&#` 本身就是异常输入。
 *  - `^[^:]*&amp;(?:colon|tab|newline|sol)` —— 实体出现在**首个冒号之前**，
 *    即协议区。`(?!\w*=)` 用来排除 `&amp;colony=1` 这类正常参数名：
 *    实体名后面紧跟 `=` 说明它其实是个查询参数，不是实体。
 *
 * ⚠️ 实体名与前瞻必须写在**同一个分组**里。若写成
 * `/&amp;(?:colon|tab)(?!\w*=)/`，正则在 `(?!\w*=)` 失败后会回溯，
 * 把实体名缩短成 `tab` 再试 —— `&amp;table=1` 这种正常查询串会被误杀。
 * 加一层 `(?:(?:...)(?!\w*=))` 后，前瞻一旦失败整个分支即告失败，不会再退。
 */
const ENTITY_SMUGGLE_RE =
  /&amp;#|^[^:]*&amp;(?:(?:colon|tab|newline|sol)(?!\w*=))/i;

/**
 * 归一化出用于**白名单判断**的 URL 形态。
 *
 * 灵感来自 DOMPurify 的 `IS_ALLOWED_URI`：浏览器解析 URL 时会忽略 ASCII
 * 控制字符与空白，所以 `java\tscript:alert(1)`、`\u0000javascript:` 放进 href
 * 依然可执行。判断前必须按同样的规则归一化，否则白名单形同虚设。
 *
 * 注意：此函数**只用于判断**。写进 DOM 的 href 始终是逃逸后的原文字符串，
 * 绝不把归一化结果当作输出（那会改变用户链接的语义）。
 */
function canonicalizeUrl(raw: string): string {
  return raw
    .trim()
    .replace(/[\u0000-\u0020\u007f]/g, "")
    .toLowerCase();
}

/**
 * 校验链接目标。安全则返回可直接写进 href 的字符串，否则返回 null（调用方降级纯文本）。
 *
 * 四重检查，任意一条不过就降级：
 *
 *  1. **实体形态的 `&` 一律拒绝**（见 ENTITY_SMUGGLE_RE 的说明），挡实体二次解码。
 *  2. **引号 / 尖括号一律拒绝**：href 用双引号包裹，用户输入绝不能闭合它。
 *     （逃逸本身也会处理，这里是纵深防御，同时避免出现"逃逸后属性值语义变了"的情况。）
 *  3. **协议必须在白名单内**。协议相对地址 `//evil.com` 取不出协议，也会被拒，
 *     符合"只允许 http/https/mailto"的约定；相对路径同理（笔记内容可能渲染在
 *     任意路由下，没有可靠基准，语义不明确）。
 *  4. **纵深防御**：逃逸后的字符串里不得再出现 `javascript:` 形态。
 */
function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // (1) 实体二次解码防线
  if (ENTITY_SMUGGLE_RE.test(trimmed)) return null;

  // (2) 属性闭合防线
  if (/["'<>]/.test(trimmed)) return null;

  // (3) 白名单协议
  const canonical = canonicalizeUrl(trimmed);
  const protocol = /^([a-z][a-z0-9+.-]*):/i.exec(canonical)?.[1];
  if (!protocol || !SAFE_PROTOCOLS.has(`${protocol}:`)) return null;

  // (4) 纵深防御：归一化并剥掉控制字符后仍能看到 javascript: 形态则拒绝。
  //     在 canonical（而不是逃逸态）上判断才有意义 —— 逃逸会把 `&colon;`
  //     变成 `&amp;colon;`，那种形态用任何正则都匹配不出 `javascript:`。
  if (/javascript\s*:/i.test(canonical)) return null;

  /**
   * 返回值就是**原样**的 trimmed，刻意不再 escapeHtml 一次。
   *
   * 原因：整份输入在入口 `renderMarkdownToHtml` 已经逃逸过一轮，这里的
   * `trimmed` 已经是逃逸态。再逃逸一次会把查询串的 `&amp;` 变成
   * `&amp;amp;` —— 链接照样能点，但 URL 里的 `&` 被双重编码，
   * 服务端收到的查询参数就错了（`?b=1&amp;c=2` 而不是 `?b=1&c=2`）。
   *
   * 之所以可以放心不再逃逸：上面第 (2) 条已经拒绝了引号与尖括号，
   * href 用双引号包裹不可能被闭合；实体二次解码也在第 (1) 条挡掉了。
   */
  return trimmed;
}

/**
 * 解析图片目标 → 可直接写进 src 的地址；不合法返回 null（调用方降级纯文本）。
 *
 * 两类目标：
 *  - `asset:<id>` —— 本地素材。id 形状由白名单正则锁定，取到的地址里
 *    不可能带引号或尖括号（正则的字符集就只有 `[0-9a-f]` `.` `[a-z0-9]`），
 *    所以拼进属性一定安全。
 *  - `http(s)://…` —— 外链图。走 safeHref 的全套检查。
 *
 * `data:` 与协议相对地址（`//host/x.png`）一律拒绝：前者是 XSS 载体，
 * 后者取不出协议、无法判断安全性。
 *
 * ⚠️ 注意 entry 已经整体逃逸过，所以这里的 URL 处于**逃逸态**：
 * 查询串里的 `&` 表现为 `&amp;`。下面的正则字符集刻意包含 `&` 和 `;`
 * 就是为了让 https 外链图能通过 —— 漏掉它们会把带参数的图床地址全拒掉。
 */
function safeImageSrc(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 素材：只认固定形状的 id，直接拼本项目自己的取回地址。
  if (trimmed.toLowerCase().startsWith(ASSET_PROTOCOL)) {
    const id = trimmed.slice(ASSET_PROTOCOL.length).trim();
    if (!ASSET_ID_RE.test(id)) return null;
    return `/api/assets/${id}`;
  }

  /*
   * 外链图：复用 safeHref 的四重检查，但**额外**要求它是 http(s)。
   *
   * 为什么不能直接返回 safeHref 的结果：safeHref 还放行 `mailto:` 和 `asset:`
   * ——`![x](mailto:a@b.com)` 会渲染成一个 src 是邮件地址的坏图，
   * 而 `asset:` 分支已经在上面处理过，这里再放行一次只会让形状判断漏过。
   */
  const href = safeHref(trimmed);
  if (href === null) return null;
  const canonical = canonicalizeUrl(href);
  if (!canonical.startsWith("http://") && !canonical.startsWith("https://")) return null;

  return href;
}

/**
 * 渲染一张图片。
 *
 * ## 为什么外层是 <span> 而不是 <figure>
 *
 * 行内解析的产物有两种归宿：独占一段（块级主循环直接输出）和被包进
 * 其它元素（段落、列表项、表格单元格、引用）。后者里出现 `<figure>`
 * 就是非法嵌套 —— `<figure>` 是块级元素，HTML 解析器遇到 `<p><figure>`
 * 会**隐式闭合 `<p>`**，把用户的一句话切成好几段，还留下一串空 `<p>`。
 * 这个 bug 在"图片独占一段"时看不出来，只有图文混排才会现形。
 *
 * 所以这里统一用 `inline-block` 的 `<span>`：在所有容器里都合法，
 * 视觉上仍然独占自己的宽度。块级场景想要的"上下留白"由 class 提供。
 *
 * ## 说明文字
 *
 * 用可见的 `<figcaption>`-like 结构而不是只写进 alt：说明在知识库里是
 * 有信息量的内容（"这张图是受击判定框"），藏进 alt 只有读屏软件看得到，
 * 等于丢了。alt 属性照样保留，两边的可访问性都不牺牲。
 *
 * `loading="lazy"`：一篇文档可能嵌几十张图，全部立刻解码会让首屏明显卡顿；
 * 图片本来就是滚动才看到的，懒加载没有副作用。
 *
 * 点击由外层 `<a>` 直接指向原图，**不依赖任何 JS**：新标签页打开即为原尺寸，
 * 相当于自带"查看大图"。渲染器输出的是 HTML 字符串，挂不上 React 事件，
 * 用纯 HTML 是这里唯一可靠的做法。
 */
function renderImage(rawAlt: string, rawSrc: string): string | null {
  const src = safeImageSrc(rawSrc);
  if (src === null) return null;

  const caption = renderInline(rawAlt);
  const altAttr = rawAlt.replace(/"/g, "&quot;");
  const img = `<img src="${src}" alt="${altAttr}" loading="lazy" decoding="async" class="${IMG_CLASS}" />`;

  const hasCaption = rawAlt.trim() !== "";
  const wrapClass = hasCaption ? FIGURE_INLINE_CLASS : `${FIGURE_INLINE_CLASS} my-4`;
  const body = hasCaption
    ? img + `<span class="${FIGCAPTION_INLINE_CLASS}">${caption}</span>`
    : img;

  return `<span class="${wrapClass}"><a href="${src}" target="_blank" rel="noopener noreferrer">${body}</a></span>`;
}

/* ------------------------------------------------------------------ *
 * 3. 行内解析
 * ------------------------------------------------------------------ */

/**
 * 行内 token 占位符：用私有区码位（U+E000 起）包住一个定长数字。
 *
 * 为什么要占位符，而不是"直接拼出标签再往后扫描"：
 *  - **行内代码**：占位符里只有数字，不含任何 Markdown 标记字符，所以后续的
 *    `**` / `*` / `~~` / `[]()` 扫描**在物理上**无法穿透进代码内容 ——
 *    "行内代码里的内容不能触发其他行内语法"这条要求由数据结构保证，
 *    而不是靠小心翼翼的正则。
 *  - **反斜杠转义**：同理。`\*` 必须变成"字面星号"，如果只是把反斜杠删掉，
 *    扫描阶段会把它当成真的斜体定界符（`\*a\*` 就会渲染成斜体）。
 *    把转义结果也变成 token，字面字符就永远不会被二次当成语法。
 *
 * 两类 token 共用一套编号，避免两套标记互相干扰。
 */
const TOKEN_RE = /\uE000(\d+)\uE001/g;
const TOKEN_MARK = (index: number): string => `\uE000${String(index).padStart(6, "0")}\uE001`;

/** 反斜杠转义：`\` + 任意非字母数字字符 = 该字符的字面量 */
const ESCAPE_RE = /\\([^A-Za-z0-9\s])/g;

/** 从 start 起找到配对的反引号下标；找不到返回 -1 */
function findClosingBacktick(text: string, start: number): number {
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "`") return i;
  }
  return -1;
}

/**
 * 行内渲染：`**粗体**`、`*斜体*`、`` `代码` ``、`[文本](链接)`、`~~删除线~~`、`\转义`。
 *
 * @param text **必须已经过 escapeHtml**。本函数只做"拼装标签"，不再触碰用户字节，
 *             所以既不会二次逃逸，也不可能把用户写的标签混进输出。
 *
 * 两趟结构：
 *  第一趟（tokenize）从左到右切出「转义字符 / 行内代码 / 链接 / 强调」四类 token。
 *    必须单趟从左到右，因为这些结构会互相抢字符（`` [a\`b](u) `` 与 `` `a\`b` ``），
 *    先扫哪一类都会误判另一类。
 *  第二趟（resolve）把 token 展开成标签，此时才递归处理嵌套（`**a *b* c**`）。
 */
export function renderInline(text: string): string {
  if (!text) return "";

  // ---- 第一趟：tokenize ----
  const tokens: string[] = [];
  const pieces: string[] = [];
  const push = (rendered: string): void => {
    pieces.push(TOKEN_MARK(tokens.push(rendered) - 1));
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // 反斜杠转义：把转义结果冻结成字面量 token
    if (ch === "\\" && i + 1 < text.length) {
      push(escapeHtml(text[i + 1]));
      i += 2;
      continue;
    }

    // 行内代码：内容原样冻结，绝不进入第二趟的正则扫描
    if (ch === "`") {
      const close = findClosingBacktick(text, i + 1);
      if (close !== -1) {
        push(`<code class="${CODE_CLASS}">${text.slice(i + 1, close)}</code>`);
        i = close + 1;
        continue;
      }
      // 落单的反引号当普通字符，避免"吃掉"用户内容
      pieces.push("`");
      i += 1;
      continue;
    }

    // 文字颜色：`{red|要标红的字}`。
    //
    // 为什么用颜色**名字**而不是十六进制：名字走白名单映射到固定的 class，
    // 值里不可能混进任意 CSS，因此不需要额外的样式净化，也不会出现
    // `{color|...}` 这种能注入 url() 之类的写法。想要新颜色就往
    // COLOR_CLASSES 里加一条，是白名单驱动的、可控的扩展方式。
    if (ch === "{") {
      const closeBrace = text.indexOf("}", i + 1);
      const pipe = text.indexOf("|", i + 1);
      if (pipe !== -1 && closeBrace !== -1 && pipe < closeBrace) {
        const name = text
          .slice(i + 1, pipe)
          .trim()
          .toLowerCase()
          .replace(/[\s_]+/g, "");
        const cls = COLOR_CLASSES[name];
        const body = text.slice(pipe + 1, closeBrace);
        // 名字不在白名单、或内容为空时按普通文本处理，不吃掉用户内容
        if (cls && body.length > 0) {
          push(`<span class="${cls}">${renderInline(body)}</span>`);
          i = closeBrace + 1;
          continue;
        }
      }
      pieces.push("{");
      i += 1;
      continue;
    }

    // 图片：`![说明](asset:xxxx.png)` 或外链图。
    //
    // 必须放在链接分支**之前**：图片语法就是"链接语法前面多一个 `!`"，
    // 先走链接分支会把 `!` 当普通字符输出，然后渲染出一个纯粹的链接。
    if (ch === "!" && text[i + 1] === "[") {
      const closeBracket = text.indexOf("]", i + 2);
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          const alt = text.slice(i + 2, closeBracket);
          const rawSrc = text.slice(closeBracket + 2, closeParen);
          const rendered = renderImage(alt, rawSrc);
          if (rendered !== null) {
            push(rendered);
            i = closeParen + 1;
            continue;
          }
          // 目标不合法（data:、协议相对、坏素材 id）→ 降级成纯文本，
          // 让用户看见自己写了什么，而不是收到一个坏图或一句被吞掉的内容
          push(`![${renderInline(alt)}](${rawSrc})`);
          i = closeParen + 1;
          continue;
        }
      }
      pieces.push("!");
      i += 1;
      continue;
    }

    // 链接：整体在这里定型，标签内容之后递归渲染（所以 `[**a**](u)` 仍然有效）
    if (ch === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          const label = text.slice(i + 1, closeBracket);
          const rawHref = text.slice(closeBracket + 2, closeParen);
          const href = safeHref(rawHref);
          if (href !== null && label.trim() !== "") {
            // 外链必须带 noopener：否则新页面可以通过 window.opener 反向操作本页
            // （reverse tabnabbing）。mailto 交给邮件客户端，不需要 target。
            const external = !canonicalizeUrl(href).startsWith("mailto:");
            const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
            push(`<a href="${href}" class="${LINK_CLASS}"${attrs}>${renderInline(label)}</a>`);
          } else {
            // 协议不安全 / 标签为空：按约定"降级为纯文本"。
            // href 用**已逃逸**的原文（它是纯文本，不会被解析）；
            // label 传**原始**文本 —— 传已 token 化的版本会造成二次展开。
            push(`[${renderInline(label)}](${rawHref})`);
          }
          i = closeParen + 1;
          continue;
        }
      }
      pieces.push("[");
      i += 1;
      continue;
    }

    // 段内换行：Markdown 规范里单换行等价于空格，但中文笔记里用户敲回车就是
    // 想换行，所以统一渲染成 <br />。放在这里而不是各处 join 点，是为了保证
    // 段落 / 列表项 / 表格单元格的行为完全一致。
    if (ch === "\n") {
      pieces.push("<br />");
      i += 1;
      continue;
    }

    if (ch === "*" || ch === "~") {
      const dbl = ch + ch;
      if (text.startsWith(dbl, i)) {
        const close = text.indexOf(dbl, i + 2);
        // 内容非空才认定为语法，否则 `****` 这类噪声会被吃成空标签
        if (close > i + 2) {
          const inner = renderInline(text.slice(i + 2, close));
          push(
            ch === "*"
              ? `<strong class="${STRONG_CLASS}">${inner}</strong>`
              : `<del class="${DEL_CLASS}">${inner}</del>`,
          );
          i = close + 2;
          continue;
        }
      }
      // 单个 `*` = 斜体。刻意不支持 `_斜体_`：`snake_case_name` 在笔记里太常见，
      // 误伤率高于收益，知识块切分也不依赖它。
      if (ch === "*") {
        const close = text.indexOf("*", i + 1);
        if (close > i + 1) {
          const inner = renderInline(text.slice(i + 1, close));
          push(`<em class="${EM_CLASS}">${inner}</em>`);
          i = close + 1;
          continue;
        }
      }
      pieces.push(ch);
      i += 1;
      continue;
    }

    pieces.push(ch);
    i += 1;
  }

  // ---- 第二趟：展开 token ----
  const joined = pieces.join("");
  return joined.replace(TOKEN_RE, (_match, digits: string) => tokens[Number(digits)] ?? "");
}

/* ------------------------------------------------------------------ *
 * 4. 块级识别正则
 *
 * 全部针对**已逃逸**的文本设计，所以引用前缀是 `&gt;` 而不是 `>`。
 * ------------------------------------------------------------------ */

const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([^`\n]*)$/;
const QUOTE_RE = /^\s*&gt;\s?/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^(\s*)([-*+])\s+(.*)$/;
const OL_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
/** 分隔行：`| --- | :--: |`，首尾竖线可省略 */
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LANG_RE = /[^A-Za-z0-9_+#.-]/g;
const INDENT_RE = /^[ \t]*/;

/** 该行是否开启一个新的块级结构。段落收集与列表续行判断都靠它短路。 */
function isBlockStart(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    TABLE_ROW_RE.test(line)
  );
}

/* ------------------------------------------------------------------ *
 * 5. 列表
 * ------------------------------------------------------------------ */

interface ListItem {
  /** 项目符号左侧的缩进宽度（Tab 记 2） */
  indent: number;
  /** 有序列表的序号；无序为 null */
  ordered: number | null;
  /** 任务项：true/false = 勾选态；null = 不是任务项 */
  task: boolean | null;
  /** 紧跟项目符号的首行文本 */
  text: string;
  /** 悬挂缩进的续行（已去掉缩进） */
  continuations: string[];
  /** 缩进更深的子项 */
  children: ListItem[];
}

/** 缩进宽度。Tab 按 2 空格算：笔记里 Tab 缩进很常见，不能让层级被算成 0。 */
function indentWidth(whitespace: string): number {
  let width = 0;
  for (const ch of whitespace) width += ch === "\t" ? 2 : 1;
  return width;
}

/**
 * 从 start 起解析一段列表，返回"项森林"与下一行的下标。
 *
 * 嵌套靠缩进栈实现：遇到新项就弹栈到"缩进严格小于自己"的位置，
 * 此时栈顶就是父项。这样 2 空格一层、以及"缩进突然变深"都能自然处理。
 */
function parseListItems(lines: readonly string[], start: number): { items: ListItem[]; next: number } {
  const roots: ListItem[] = [];
  const stack: ListItem[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const ul = UL_RE.exec(line);
    const ol = ul ? null : OL_RE.exec(line);
    const match = ul ?? ol;

    if (match) {
      const indent = indentWidth(match[1]);
      const rest = match[3];
      const task = TASK_RE.exec(rest);
      const item: ListItem = {
        indent,
        ordered: ol ? Number(ol[2]) : null,
        task: task ? task[1].toLowerCase() === "x" : null,
        text: task ? task[2] : rest,
        continuations: [],
        children: [],
      };
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(item);
      else roots.push(item);
      stack.push(item);
      i += 1;
      continue;
    }

    // 续行：非空、有缩进、且缩进深于某个尚未闭合的项。
    // 从栈顶往下找第一个"更浅"的项作为归属 —— 这样"父项 + 缩进续行 + 子项 + 同级续行"
    // 这类混排也能正确挂载，而不会让列表提前结束。
    if (line.trim() && /^\s{2,}/.test(line) && stack.length > 0) {
      const width = indentWidth(INDENT_RE.exec(line)?.[0] ?? "");
      let owner: ListItem | null = null;
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k].indent < width) {
          owner = stack[k];
          break;
        }
      }
      if (owner) {
        const text = line.trim();
        // 续行本身也可能是块级结构（引用 / 表格 / 标题）：那就不属于这个列表，
        // 交回外层循环，缩进层级由外层重新判定。
        if (isBlockStart(text)) break;
        owner.continuations.push(text);
        i += 1;
        continue;
      }
    }

    break;
  }

  return { items: roots, next: i };
}

/** 渲染单个列表项；子列表必须放在内容之后、`</li>` 之前 */
function renderListItem(item: ListItem): string {
  const lines = [item.text, ...item.continuations];

  if (item.task !== null) {
    // 任务列表：disabled 的 checkbox，纯展示。真实勾选交互由编辑器负责，
    // 渲染器返回的是字符串，本来也挂不上事件。
    const box = `<input type="checkbox" disabled${item.task ? " checked" : ""} class="${CHECKBOX_CLASS}" />`;
    const span = `<span class="min-w-0 flex-1">${renderInline(lines.join("\n"))}</span>`;
    const nested = item.children.length > 0 ? renderList(item.children) : "";
    return `<li class="${TODO_LI_CLASS}">${box}${span}${nested}</li>`;
  }

  // 多行的松散项用 <p> 包一层，保留换行同时维持 li 的语义
  const body =
    lines.length > 1
      ? `<p class="my-1 text-sm leading-7">${renderInline(lines.join("\n"))}</p>`
      : renderInline(lines[0] ?? "");
  const nested = item.children.length > 0 ? renderList(item.children) : "";
  return `<li class="${LI_CLASS}">${body}${nested}</li>`;
}

/**
 * 渲染一层列表。
 *
 * 同级项若"有序 / 无序"混杂（`1. a` 后面跟 `- b`），必须拆成两个相邻列表，
 * 否则 HTML 结构非法、浏览器会自作主张重排。这里以"类型变了就重开一个列表"处理。
 */
function renderList(items: readonly ListItem[]): string {
  let html = "";
  let currentOrdered: boolean | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    const tag = currentOrdered ? "ol" : "ul";
    const kind = currentOrdered ? "list-decimal" : "list-disc";
    html += `<${tag} class="${LIST_CLASS} ${kind}">${buffer.join("")}</${tag}>`;
    buffer = [];
  };

  for (const item of items) {
    const ordered = item.ordered !== null;
    if (currentOrdered === null) {
      currentOrdered = ordered;
    } else if (currentOrdered !== ordered) {
      flush();
      currentOrdered = ordered;
    }
    buffer.push(renderListItem(item));
  }
  flush();

  return html;
}

/* ------------------------------------------------------------------ *
 * 6. 表格
 * ------------------------------------------------------------------ */

/** 单元格里的 `\|` 是转义竖线，不能当分隔符：先换成占位符、切完再换回来 */
function splitTableRow(line: string): string[] {
  const placeholder = "\uE003";
  const replaced = line.replace(/\\\|/g, placeholder);
  let cells = replaced.trim().split("|");
  // 行首 / 行尾的竖线会产生空串，去掉才能对齐列
  if (cells.length > 0 && cells[0].trim() === "") cells = cells.slice(1);
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells = cells.slice(0, -1);
  return cells.map((cell) => cell.split(placeholder).join("|").trim());
}

/** 由分隔行解析每列对齐方式 */
function parseAlignments(cells: readonly string[]): Align[] {
  return cells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

function renderTable(header: readonly string[], rows: readonly string[][], aligns: readonly Align[]): string {
  // 列数以表头为准：数据行多出来的列丢弃、缺的列补空。
  // 这样用户手滑多写一根竖线不会让整张表错位。
  const width = header.length;
  const pad = (cells: readonly string[]): string[] =>
    Array.from({ length: width }, (_unused, idx) => cells[idx] ?? "");
  const alignOf = (idx: number): string => ALIGN_CLASS[aligns[idx] ?? "left"];

  const head = pad(header)
    .map((cell, idx) => `<th class="${TH_CLASS} ${alignOf(idx)}">${renderInline(cell)}</th>`)
    .join("");

  const body = rows
    .map((row) => {
      const tds = pad(row)
        .map((cell, idx) => `<td class="${TD_CLASS} ${alignOf(idx)}">${renderInline(cell)}</td>`)
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");

  return (
    `<div class="${TABLE_WRAP_CLASS}"><table class="${TABLE_CLASS}"><thead><tr>${head}</tr></thead>` +
    `<tbody>${body}</tbody></table></div>`
  );
}

/* ------------------------------------------------------------------ *
 * 7. 代码块
 * ------------------------------------------------------------------ */

/** 围栏 info string → 语言类名。只保留安全字符，避免拼出畸形属性。 */
function codeLanguage(info: string): string {
  const first = info.trim().split(/\s+/)[0] ?? "";
  return first.replace(LANG_RE, "");
}

/** 渲染一个围栏代码块 */
function renderCodeBlock(lines: readonly string[], language: string): string {
  const lang = language ? ` language-${language}` : "";
  // 内容已经是逃逸文本，直接拼接；空格与缩进原样保留（不 trim），
  // 否则用户精心对齐的代码会走形。
  return `<pre class="${PRE_CLASS}"><code class="${PRE_CODE_CLASS}${lang}">${lines.join("\n")}</code></pre>`;
}

/* ------------------------------------------------------------------ *
 * 8. 块级主循环
 * ------------------------------------------------------------------ */

/**
 * 块级解析主循环。
 *
 * @param lines **已经逃逸过的**文本按 `\n` 切成的行。本函数内所有字符串都是
 *              逃逸态，绝不能再调用 escapeHtml —— 这正是"只有一个逃逸点"的落地方式。
 *
 * 为什么不把"逃逸"放进这个函数：引用（blockquote）需要递归复用块级逻辑，
 * 而递归时文本已经逃逸过了。让主循环只接收"已逃逸行"，就只剩余一个
 * 负责逃逸的公开入口，不会有人误用未逃逸的版本。代价是 renderList /
 * renderTable 等辅助函数也被设计成"只拼标签、不逃逸"，保持一致。
 */
function renderBlocks(lines: readonly string[]): string {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ---- 空行：跳过 ----
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // ---- 围栏代码块：必须放在所有块级判断的最前面 ----
    // 一旦进入围栏就整体短路到闭合围栏为止，内部**不解析任何 Markdown**。
    // 于是"代码里的 `# 标题` / `**粗体**` / `| 表格 |`"天然不会被解析，
    // 不需要额外做"跳过代码区"的标记位。这也是唯一正确的处理顺序：
    // 若先判断标题，代码块里的 `#` 就先被吃掉了。
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[2][0];
      const markerLen = fence[2].length;
      const language = codeLanguage(fence[3] ?? "");
      // 闭合围栏：同种标记、长度不短于开始围栏、行内没有别的内容
      const closer = new RegExp(`^\\s*\\${marker}{${markerLen},}\\s*$`);
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length) {
        if (closer.test(lines[i])) {
          i += 1;
          break;
        }
        buffer.push(lines[i]);
        i += 1;
      }
      // 未闭合时把剩余内容全部当代码（与 parseMarkdown 的兜底一致），不丢用户内容
      out.push(renderCodeBlock(buffer, language));
      continue;
    }

    // ---- 水平线 ----
    if (HR_RE.test(line)) {
      out.push(`<hr class="${HR_CLASS}" />`);
      i += 1;
      continue;
    }

    // ---- ATX 标题 ----
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      // 去掉可选的闭合井号：`## 标题 ##`
      const text = heading[2].replace(/\s*#+\s*$/, "").trim();
      out.push(`<h${level} class="${HEADING_CLASS[level - 1]}">${renderInline(text)}</h${level}>`);
      i += 1;
      continue;
    }

    // ---- 表格：本行是 |...|，且下一非空行是分隔行 ----
    if (TABLE_ROW_RE.test(line)) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j += 1;
      // 分隔行必须**紧邻**表头行：这里特意用 `j` 而不是 `i + 1` 去找，
      // 但要求 `j === i + 1`，否则"表格 + 空行 + 正文"会被误判成表格。
      if (j === i + 1 && j < lines.length && TABLE_DELIM_RE.test(lines[j])) {
        const headers = splitTableRow(line);
        const aligns = parseAlignments(splitTableRow(lines[i + 1]));
        const rows: string[][] = [];
        i = j + 1;
        while (i < lines.length && lines[i].trim() && TABLE_ROW_RE.test(lines[i])) {
          rows.push(splitTableRow(lines[i]));
          i += 1;
        }
        out.push(renderTable(headers, rows, aligns));
        continue;
      }
      // 不是合法表格（例如正文里单独一段带竖线的文字）→ 落到段落分支
    }

    // ---- 引用 ----
    if (QUOTE_RE.test(line)) {
      const buffer: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (QUOTE_RE.test(cur)) {
          buffer.push(cur.replace(QUOTE_RE, ""));
          i += 1;
          continue;
        }
        // 引用内的空行：仅当后面还有引用行时才继续（与 parseMarkdown 语义一致）
        if (!cur.trim()) {
          let k = i + 1;
          while (k < lines.length && !lines[k].trim()) k += 1;
          if (k < lines.length && QUOTE_RE.test(lines[k])) {
            buffer.push("");
            i = k;
            continue;
          }
        }
        break;
      }
      // 递归渲染：引用里可以有标题、列表、代码块，体验比"引用一律纯文本"好得多。
      // 注意传的是 renderBlocks（已逃逸入口），不是 renderMarkdownToHtml，
      // 否则会把 `&gt;` 再逃逸成 `&amp;gt;`。
      out.push(`<blockquote class="${QUOTE_CLASS}">${renderBlocks(buffer)}</blockquote>`);
      continue;
    }

    // ---- 列表 / 任务列表（含一层嵌套）----
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const { items, next } = parseListItems(lines, i);
      out.push(renderList(items));
      i = next;
      continue;
    }

    // ---- 段落兜底 ----
    // 连续的非空、非块起始行合成一段，行内换行渲染成 <br />（笔记场景更符合直觉）。
    // 兜底分支保证循环一定推进：即使某行谁都不认，也会作为段落被消费掉。
    const buffer: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (!cur.trim() || isBlockStart(cur)) break;
      buffer.push(cur.trim());
      i += 1;
    }
    if (buffer.length === 0) {
      buffer.push(line.trim());
      i += 1;
    }
    out.push(`<p class="${P_CLASS}">${renderInline(buffer.join("\n"))}</p>`);
  }

  return out.join("\n");
}

/* ------------------------------------------------------------------ *
 * 9. 公开入口
 * ------------------------------------------------------------------ */

/**
 * 把 Markdown 渲染成 HTML 字符串。
 *
 * 纯函数：同一输入永远得到同一输出，不读时钟、不读随机数、不碰 DOM。
 * 因此可以安全地放进 React 的 `useMemo`，也能在服务端预渲染。
 *
 * 输出是**可信 HTML**（用户内容已 100% 逃逸），调用方直接
 * `dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(md) }}` 即可。
 * 不要再套一层 sanitizer —— 那只会把 `<code>&lt;div&gt;</code>` 里的
 * `&lt;` 再逃逸一次，页面上就显示出 `&lt;div&gt;` 字面量了。
 */
export function renderMarkdownToHtml(markdown: string): string {
  if (!markdown) return "";

  // 1) 统一换行符（Windows 粘贴的 \r\n 会让所有 `$` 锚定正则失效）
  // 2) 剥掉可能存在的 BOM，否则首行的 `#` 识别不出来
  // 3) 唯一的逃逸点，见文件头"安全模型"
  const normalized = markdown.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
  return renderBlocks(escapeHtml(normalized).split("\n"));
}
