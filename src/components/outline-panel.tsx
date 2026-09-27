"use client";

/**
 * 文档大纲导航面板 —— 长文档里"我在哪、要去哪"的全局视图。
 *
 * 文档被切成知识块之后，每个段落都是独立单元，光靠滚动条已经找不回
 * 结构感。这个面板把标题块抽出来组装成树，作为唯一的层级入口。
 *
 * 三个关键决策（都有代价，写在这里免得后人改错）：
 *
 *  1. **层级用栈组装，不用递归分组** —— 见 parseHeadings 的注释。
 *  2. **缩进用内联 style，不用 Tailwind 类名** —— Tailwind 4 是静态扫描
 *     源文件生成类名的，`pl-[${n}px]` 这种运行时拼出来的类名永远不会被
 *     生成，写了也是死类名。
 *  3. **滚动跟随只允许容器内滚动** —— scrollIntoView 会连带滚动所有可滚动
 *     祖先，若不管，编辑器里光标一动整页就跟着跳。这里在调用前后记账页面
 *     滚动位置，被改动就还原。
 */

import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, ListTree, Search, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from "react";

import { cn } from "@/lib/ui/client";

/* ------------------------------------------------------------------ *
 * 契约
 * ------------------------------------------------------------------ */

export interface OutlineBlock {
  id: string;
  /** "heading" | "paragraph" | "code" | "quote" | "list" | "todo" | "table" */
  kind: string;
  /** 块原文（Markdown 片段） */
  text: string;
  /** 文档内序号 */
  seq: number;
}

export interface OutlinePanelProps {
  blocks: OutlineBlock[];
  /** 编辑区里当前可见/选中的块 id，用于高亮对应的大纲项 */
  activeBlockId?: string | null;
  /** 点击大纲项时回调，调用方负责滚动到该块 */
  onNavigate: (blockId: string) => void;
  className?: string;
}

export interface HeadingNode {
  id: string;
  level: number; // 1~6
  title: string; // 去掉 # 与首尾空白后的文字
  seq: number;
  children: HeadingNode[];
}

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/**
 * ATX 标题。`#` 与文字之间必须有空白 —— 否则 `#标签`、`#include <stdio.h>`
 * 都会被当成标题。
 *
 * 刻意与 `lib/blocks/parse-blocks.ts` 里的 HEADING_RE 保持一致：两边不一致时，
 * 大纲会凭空多出（或漏掉）编辑器里并不存在的标题。
 */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** 每级缩进 12px，落到内联 style 上（原因见文件头第 2 条）。 */
const INDENT_PER_LEVEL = 12;

/** 标题超过这个数量就让列表区自己滚动，而不是把整个侧栏越撑越长。 */
const SCROLL_THRESHOLD = 12;

const UNTITLED = "（无标题）";

/**
 * 大纲面板宽度的夹取范围。
 *
 * 下限保证连"（无标题）"这种最短内容也放得下；上限防止一个超长标题
 * 把正文挤到只剩一半 —— 大纲是导航，不该抢正文的地方。
 */
const MIN_OUTLINE_WIDTH = 168;
const MAX_OUTLINE_WIDTH = 340;

/**
 * 空态引导。
 *
 * 最后一句不是客套：解析器只认 ATX 标题，中文习惯的「一、」「二、」是普通段落，
 * 用户写了半天发现大纲里没有它，必须有一句话解释清楚，否则会以为是 bug。
 */
const EMPTY_HINT =
  "这篇文档还没有标题。用 # 开头写一行，它就会出现在这里。「一、」「二、」这类中文序号不会被识别为标题。";

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

/**
 * 读出一个标题块的层级与文字。
 *
 * 只取第一行：块的 text 是 Markdown 片段，标题语义只存在于首行。
 * 先 trim 再匹配：`"## 标题\n"` 这种尾巴上带换行的块，若直接匹配会失配，
 * 把一个真标题降级成 level 1。
 *
 * 兜底（正则失配）：按 level 1 处理，title 去掉前导 `#` 与空白。
 * 这条兜底是宽松策略 —— `kind === "heading"` 的块一个都不能丢，
 * 也不能因为解析失败就得到 NaN 层级。顺带解释了 `####`（只有井号没有文字）
 * 这类块：它们同样被保留，只是 title 为空串，界面上显示「（无标题）」。
 */
function readHeading(text: string): { level: number; title: string } {
  const firstLine = text.trim().split("\n", 1)[0].trim();
  const match = HEADING_RE.exec(firstLine);
  if (match) {
    return { level: match[1].length, title: match[2].trim() };
  }
  return { level: 1, title: firstLine.replace(/^#+\s*/, "").trim() };
}

/**
 * 把块序列里的标题抽出来，按层级组装成树。非标题块被忽略。
 *
 * **为什么用栈而不是"按 level 递归分组"**：
 *
 * 递归分组的写法是"h1 的子树 = 后面所有 level > 1 的标题"，它隐含要求层级
 * 逐级递增。一旦遇到跳级（h1 直接跟 h3，中间没有 h2 —— 用户手写文档时极其
 * 常见），递归分组只有两条路：要么丢掉那个 h3，要么凭空造一个空的 h2 占位
 * 节点。前者丢内容，后者让大纲里出现用户文档里根本不存在的标题。
 *
 * 栈的写法把"跳级"变成天然合法的情形：
 *
 *   - 新标题 level 为 L 时，把栈里 level >= L 的全部弹出（它们不可能再是
 *     后续标题的祖先，因为后面的标题层级只会 >= L 或更浅）；
 *   - 此时栈顶就是最近的祖先；栈空了就挂到根上；
 *   - 把新节点压栈，成为后续更深标题的潜在祖先。
 *
 * 一趟遍历同时得到正确的父子关系**和**与块出现顺序一致的输出顺序 ——
 * 不需要二次排序，也不会产生占位节点。复杂度 O(n)。
 *
 * 另外两个被规则明确要求的行为：
 *  - 文档以 h2 开头（甚至以 h6 开头）完全合法：栈一开始是空的，它就是根节点；
 *  - 同级回退（h2 → h3 → h2）时第二个 h2 会把 h3、h2 一起弹掉，落到根上，
 *    与第一个 h2 平级。
 */
export function parseHeadings(blocks: readonly OutlineBlock[]): HeadingNode[] {
  const roots: HeadingNode[] = [];
  /** 栈底是最近的顶层标题，栈顶是最近的祖先 */
  const stack: HeadingNode[] = [];

  for (const block of blocks) {
    // 非标题块直接跳过：它们既不出现在树里，也不影响其余标题的相对顺序
    if (block.kind !== "heading") continue;

    const { level, title } = readHeading(block.text);
    const node: HeadingNode = {
      id: block.id,
      level,
      title,
      seq: block.seq,
      children: [],
    };

    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    const parent = stack.length > 0 ? stack[stack.length - 1] : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);

    stack.push(node);
  }

  return roots;
}

/** 深度优先拍平：渲染用一维数组，key / ref 好管理，也不会有嵌套列表的样式纠缠。 */
function flattenAll(nodes: readonly HeadingNode[]): HeadingNode[] {
  const out: HeadingNode[] = [];
  for (const node of nodes) {
    out.push(node);
    out.push(...flattenAll(node.children));
  }
  return out;
}

/** 某节点下**所有后代**的数量（不含自己）。折叠时用来提示"这里还藏着多少条"。 */
function countDescendants(node: HeadingNode): number {
  let total = 0;
  for (const child of node.children) {
    total += 1 + countDescendants(child);
  }
  return total;
}

/** 所有"有子节点"的 id —— "全部折叠"按钮需要它来决定折哪些、以及自己是否已生效 */
function collectParents(nodes: readonly HeadingNode[], into: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    if (node.children.length > 0) {
      into.add(node.id);
      collectParents(node.children, into);
    }
  }
  return into;
}

/**
 * 按标题的实际长度估算一个合适的面板宽度。
 *
 * ## 为什么需要它
 *
 * 面板宽度原先固定 210px，而标题被 `truncate` 切掉 —— 用户给小节起名就是为了
 * 概括内容，被省略号切一半等于白起名。现在允许折行，但折行太多同样难读：
 * 标题一长就变成三四行，扫描时反而更慢。
 *
 * 所以按"最长标题大概占多宽"给出一个初始宽度，让常见标题一行放得下。
 * 结果是**起点合适**，用户仍可拖拽调整（见 editor-panel 的 Divider）。
 *
 * 估算规则：
 *  - 中日韩字符按整宽、其余按约 0.58 宽（与图表渲染器的估算保持一致的做法）；
 *  - 缩进按最深层级预留（每级 `INDENT_PER_LEVEL`）；
 *  - 夹在 [MIN_OUTLINE_WIDTH, MAX_OUTLINE_WIDTH] 之间 —— 太窄放不下，
 *    太宽会把正文挤没。
 *
 * 取的是**中位数偏上**而不是绝对最大值：一个超长标题不该把整个面板撑开。
 */
export function estimateOutlineWidth(blocks: readonly OutlineBlock[]): number {
  const headings = blocks.filter((b) => b.kind === "heading");
  if (headings.length === 0) return MIN_OUTLINE_WIDTH;

  /** 与图表渲染器同一套宽度的粗略估算 */
  const textWidth = (text: string): number => {
    let units = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      units += cp > 0x2e7f ? 1 : 0.58;
    }
    return units * 12; // 大纲字号是 12px
  };

  const widths: number[] = [];
  let maxLevel = 1;
  for (const block of headings) {
    const { level, title } = readHeading(block.text);
    maxLevel = Math.max(maxLevel, level);
    widths.push(textWidth(title || UNTITLED));
  }
  widths.sort((a, b) => a - b);

  // 取 80 分位：让绝大多数标题一行放得下，同时不被极端长标题带跑
  const idx = Math.min(widths.length - 1, Math.floor(widths.length * 0.8));
  const indent = (maxLevel - 1) * INDENT_PER_LEVEL;
  // padding（左右）+ 高亮条 + 间隙
  const chrome = 8 + 2 + 6 + 12;

  return Math.round(
    Math.min(MAX_OUTLINE_WIDTH, Math.max(MIN_OUTLINE_WIDTH, widths[idx] + indent + chrome)),
  );
}

interface OutlineRow {
  node: HeadingNode;
  /** 自身命中查询词；false 表示它只是被留下来的祖先（渲染时弱化） */
  matched: boolean;
  /**
   * 该行是否被折叠的祖先隐藏掉了。
   *
   * 为什么保留隐藏行而不是直接不生成：`rows` 的**长度**要稳定，
   * 否则折叠状态一变就得重算整棵树；而且"隐藏"是纯展示决策，
   * 把它混进解析层会让 parseHeadings 的职责变糊。
   */
  hidden: boolean;
}

/**
 * 过滤：命中项的**祖先链**必须一起留下。
 *
 * 只留命中项的话，一条 `###` 会孤零零地出现在顶层缩进上，读者根本不知道它
 * 属于哪一节 —— 所以祖先即使自身不匹配也保留，只是渲染得更弱（次要色），
 * 让人一眼看出"这条是为了保住层级才出现的"。
 *
 * 实现上先按文档顺序压入再回撤：子树走完仍未命中就把自己那一行撤掉，
 * 这样输出顺序天然与原文一致。
 *
 * ## 搜索时为什么要**强制展开**（`forceExpand`）
 *
 * 折叠与搜索是两个互相打架的功能：用户折起了某一节，然后搜索一个正好在
 * 那一节里的标题 —— 如果折叠还生效，搜索结果会被自己的折叠状态藏起来，
 * 表现成"搜到了但看不见"，比不搜还糟。所以搜索期间忽略折叠，命中项一律可见。
 */
function filterTree(
  nodes: readonly HeadingNode[],
  needle: string,
  collapsed: ReadonlySet<string>,
  forceExpand: boolean,
): OutlineRow[] {
  const rows: OutlineRow[] = [];

  const walk = (list: readonly HeadingNode[], parentCollapsed: boolean): boolean => {
    let anyMatched = false;
    for (const node of list) {
      // 空 needle = 不过滤：每个节点都算命中，于是这里只有一条代码路径
      const self = needle === "" || node.title.toLowerCase().includes(needle);
      const at = rows.length;
      const isCollapsed = !forceExpand && collapsed.has(node.id);
      // 自己的父链上只要有一层折起来了，自己就不可见
      rows.push({ node, matched: self, hidden: parentCollapsed });
      const descendantMatched = walk(node.children, parentCollapsed || isCollapsed);
      if (!self && !descendantMatched) {
        rows.splice(at, 1); // 自己和整棵子树都没命中，撤掉这一行
        continue;
      }
      anyMatched = true;
    }
    return anyMatched;
  };

  walk(nodes, false);
  return rows;
}

/* ------------------------------------------------------------------ *
 * 组件
 * ------------------------------------------------------------------ */

export default function OutlinePanel({
  blocks,
  activeBlockId,
  onNavigate,
  className,
}: OutlinePanelProps): JSX.Element {
  const [query, setQuery] = useState("");

  /*
   * 折叠状态：存**被折起来**的节点 id 集合。
   *
   * 为什么存"折叠的"而不是"展开的"：默认状态是全部展开（不存任何 id），
   * 于是空集合就是默认值 —— 用"展开集合"的话，空集合意味着"全部折叠"，
   * 新文档一打开大纲全是收起的，反而要多点几下。语义与默认值一致更省心。
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // useId 而不是随机数/自增：SSR 与客户端水合后必须一致
  const inputId = useId();
  const listId = useId();

  /** 解析结果缓存：文档编辑时父组件会高频重渲染，块序列不变就不该重算 */
  const tree = useMemo(() => parseHeadings(blocks), [blocks]);

  /** 全量标题数（用于计数与"是否需要滚动"的判断） */
  const headingCount = useMemo(() => flattenAll(tree).length, [tree]);

  const needle = query.trim().toLowerCase();
  const searching = needle !== "";

  /**
   * 过滤 + 折叠的结果。**只有一条计算路径** —— 空查询就是"needle 为空串"，
   * 它在 filterTree 里会让每个节点都命中，于是"不过滤"和"过滤"共用同一份
   * 遍历代码。分成两个分支写过一次，两边很容易在折叠语义上走偏。
   *
   * 搜索期间强制展开：折叠不该把搜索结果藏起来（见 filterTree 注释）。
   */
  const rows = useMemo<OutlineRow[]>(
    () => filterTree(tree, needle, collapsed, searching),
    [tree, needle, collapsed, searching],
  );

  /** 可见行 —— 隐藏行不参与渲染，但保留在 rows 里（见 OutlineRow 注释） */
  const visibleRows = useMemo(() => rows.filter((row) => !row.hidden), [rows]);

  /** 所有"有子节点"的 id：全部折叠时用，也用于判断按钮当前该显示哪种状态 */
  const parentIds = useMemo(() => collectParents(tree), [tree]);

  const hasMany = headingCount > SCROLL_THRESHOLD;

  const listRef = useRef<HTMLDivElement | null>(null);
  /** id → 大纲项 DOM 节点，用于把高亮项滚进视野 */
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());

  // 用 Map 而不是每项一个 ref：项数随文档变化，回调必须保持稳定引用，
  // 否则 React 每次渲染都会先 unmount 再 mount 一遍 ref（并丢掉 map 内容）。
  const registerItem = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) itemRefs.current.set(id, el);
    else itemRefs.current.delete(id);
  }, []);

  /*
   * 滚动跟随：让 activeBlockId 对应的项在列表区里可见。
   *
   * 只在容器真的溢出时才动手，并且把页面滚动位置还原 —— 用户正在编辑区
   * 打字时，任何整页跳动都是不可接受的。
   * 依赖里的 rows 变了（换了文档、改了过滤词）也重算一次：此时高亮项可能是
   * 刚被渲染出来的，需要重新滚进来。
   */
  useEffect(() => {
    if (!activeBlockId) return;
    // effect 只会在浏览器里跑；这层判断是为了让本组件在非 DOM 渲染器下也安全
    if (typeof window === "undefined") return;

    const el = itemRefs.current.get(activeBlockId);
    // react-test-renderer 之类的渲染器给的 ref 不是真 DOM 节点，没有这个方法
    if (!el || typeof el.scrollIntoView !== "function") return;

    const container = listRef.current;
    if (container && container.scrollHeight <= container.clientHeight) return; // 没溢出，不用滚

    const pageX = window.scrollX;
    const pageY = window.scrollY;
    el.scrollIntoView({ block: "nearest" }); // nearest：已可见时是空操作
    if (window.scrollX !== pageX || window.scrollY !== pageY) {
      window.scrollTo(pageX, pageY); // 只允许列表区自己滚，页面不许动
    }
  }, [activeBlockId, rows]);

  return (
    <nav
      aria-label="文档大纲"
      className={cn(
        "flex h-full min-h-0 flex-col rounded-xl border border-[#23282f] bg-[#12151a]",
        className,
      )}
    >
      {/* 标题行 */}
      <div className="flex items-center gap-1.5 border-b border-[#23282f] px-3 py-2">
        <ListTree size={13} className="shrink-0 text-[#3ddc97]" aria-hidden="true" />
        <span className="text-[12px] font-medium text-[var(--nodes-ink)]">大纲</span>
        {needle !== "" && (
          <span className="ml-auto font-mono text-[10px] text-[#3ddc97]">
            {`匹配 ${rows.length}`}
          </span>
        )}
        {/*
          "全部折叠"。
          
          用户的原话是细粒度的大纲"食之无味，弃之可惜" —— 问题不在信息本身，
          而在一屏塞了太多条，看不出结构。一键只留顶层，就是让它在
          "看骨架"和"看细节"之间切换，而不是只能在"太细"和"没有"之间选。
        */}
        {parentIds.size > 0 && (
          <button
            type="button"
            onClick={() =>
              setCollapsed((prev) => (prev.size >= parentIds.size ? new Set() : new Set(parentIds)))
            }
            title={collapsed.size >= parentIds.size ? "展开全部" : "折叠到只剩顶层"}
            aria-label={collapsed.size >= parentIds.size ? "展开全部大纲" : "折叠全部大纲，只留顶层"}
            className={cn(
              "shrink-0 rounded p-0.5 text-[var(--nodes-ink-faint)] transition-colors hover:bg-[#171b21] hover:text-[var(--nodes-ink)] focus-visible:ring-2 focus-visible:ring-[#3ddc97] focus-visible:outline-none",
              needle === "" && "ml-auto",
            )}
          >
            {collapsed.size >= parentIds.size ? (
              <ChevronsDownUp size={12} aria-hidden="true" />
            ) : (
              <ChevronsUpDown size={12} aria-hidden="true" />
            )}
          </button>
        )}
      </div>

      {/* 过滤框 */}
      <div className="border-b border-[#23282f] px-3 py-2">
        <label className="sr-only" htmlFor={inputId}>
          按标题文字过滤大纲
        </label>
        <div className="flex items-center gap-1.5 rounded-md border border-[#23282f] bg-[#0b0d10] px-2 py-1 transition-colors focus-within:border-[#3ddc97]/60">
          <Search size={11} className="shrink-0 text-[var(--nodes-ink-faint)]" aria-hidden="true" />
          <input
            id={inputId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="过滤标题…"
            aria-controls={listId}
            autoComplete="off"
            spellCheck={false}
            className="w-full min-w-0 bg-transparent text-[11px] text-[var(--nodes-ink)] placeholder:text-[var(--nodes-ink-faint)] focus:outline-none"
          />
          {query !== "" && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="清空过滤"
              className="shrink-0 rounded p-0.5 text-[var(--nodes-ink-faint)] transition-colors hover:bg-[#171b21] hover:text-[var(--nodes-ink)] focus-visible:ring-2 focus-visible:ring-[#3ddc97] focus-visible:outline-none"
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* 列表区：标题多时自己滚动 */}
      <div
        id={listId}
        ref={listRef}
        className={cn("min-h-0 flex-1 overflow-y-auto px-2 py-1.5", hasMany && "max-h-[60vh]")}
      >
        {headingCount === 0 ? (
          <p className="rounded-md bg-[#171b21] px-2.5 py-2 text-[11px] leading-relaxed text-[var(--nodes-ink-dim)]">
            {EMPTY_HINT}
          </p>
        ) : visibleRows.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] leading-relaxed text-[var(--nodes-ink-faint)]">
            {`没有匹配「${query.trim()}」的标题。`}
          </p>
        ) : (
          <ul role="list" className="space-y-px">
            {visibleRows.map(({ node, matched }) => {
              const label = node.title === "" ? UNTITLED : node.title;
              const active = node.id === activeBlockId;
              const hasChildren = node.children.length > 0;
              const isCollapsed = collapsed.has(node.id);
              return (
                <li key={node.id} className="flex items-start gap-0.5">
                  {/*
                    折叠箭头。没有子标题的位置留一个等宽占位符，
                    否则同级标题会因"有没有箭头"而左右错开，看起来像层级错乱。
                  */}
                  {hasChildren ? (
                    <button
                      type="button"
                      onClick={() => toggleCollapse(node.id)}
                      aria-expanded={!isCollapsed}
                      aria-label={`${isCollapsed ? "展开" : "折叠"}「${label}」下的 ${node.children.length} 个小节`}
                      title={isCollapsed ? "展开" : "折叠"}
                      style={{ marginLeft: `${(node.level - 1) * INDENT_PER_LEVEL}px` }}
                      className="mt-[3px] shrink-0 rounded p-0.5 text-[var(--nodes-ink-faint)] transition-colors hover:bg-[#171b21] hover:text-[var(--nodes-ink)] focus-visible:ring-2 focus-visible:ring-[#3ddc97] focus-visible:outline-none"
                    >
                      {isCollapsed ? <ChevronRight size={10} aria-hidden="true" /> : <ChevronDown size={10} aria-hidden="true" />}
                    </button>
                  ) : (
                    <span
                      aria-hidden="true"
                      style={{ marginLeft: `${(node.level - 1) * INDENT_PER_LEVEL}px` }}
                      className="mt-[3px] w-[14px] shrink-0"
                    />
                  )}
                  <button
                    type="button"
                    ref={(el) => registerItem(node.id, el)}
                    onClick={() => onNavigate(node.id)}
                    aria-current={active ? "true" : undefined}
                    title={`H${node.level} · ${label}`}
                    className={cn(
                      // items-start + 折行：标题多行时图标与高亮条停在第一行，
                      // 而不是被垂直居中到两行之间（那样看起来像错位）
                      "flex min-w-0 flex-1 items-start gap-1.5 rounded-md py-1 pr-2 text-left text-[12px] leading-tight transition-colors",
                      "focus-visible:ring-2 focus-visible:ring-[#3ddc97] focus-visible:outline-none",
                      active
                        ? "bg-[#171b21] font-medium text-[#3ddc97]"
                        : matched
                          ? "text-[var(--nodes-ink)] hover:bg-[#171b21]"
                          : "text-[var(--nodes-ink-dim)] hover:bg-[#171b21]",
                    )}
                  >
                    {/* 高亮不只用颜色表达（色觉障碍下也要能分辨） */}
                    <span
                      aria-hidden="true"
                      className="mt-0.5 h-3 w-[2px] shrink-0 rounded-full"
                      style={{ background: active ? "#3ddc97" : "transparent" }}
                    />
                    {/*
                      标题**不截断**，允许折行。
 
                      用户给小节起名就是为了概括内容，被省略号切掉一半等于白起名。
                      面板宽度可以由拖拽调整（见 editor-panel 的 Divider），
                      所以这里应该让文字自然换行，而不是用 truncate 一刀切。
                      保留 title 属性只是为了悬停时能看到完整层级信息。
                    */}
                    <span
                      className={cn(
                        "min-w-0 break-words",
                        node.title === "" && (active ? "italic" : "text-[var(--nodes-ink-faint)] italic"),
                      )}
                    >
                      {label}
                    </span>
                    {/* 折叠时提示"这里还藏着多少条"，否则收起后完全看不出规模 */}
                    {isCollapsed && hasChildren && (
                      <span className="ml-auto shrink-0 pl-1 font-mono text-[10px] text-[var(--nodes-ink-faint)]">
                        {countDescendants(node)}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 计数 */}
      <div className="flex items-center justify-between gap-2 border-t border-[#23282f] px-3 py-1.5 text-[10px] text-[var(--nodes-ink-faint)]">
        <span>{`共 ${headingCount} 个小节`}</span>
        {needle !== "" && <span aria-live="polite">{`匹配 ${rows.length} 个`}</span>}
      </div>
    </nav>
  );
}
