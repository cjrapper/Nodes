/**
 * Markdown 块解析 —— **前后端共用的纯函数模块**。
 *
 * 刻意从 `lib/blocks/markdown.ts` 里拆出来，因为那个文件还依赖
 * `node:crypto`（算哈希），无法被客户端组件导入；而编辑器的实时预览
 * 必须能在浏览器里就地把 Markdown 切成块，才能做到"边写边看到块结构"。
 *
 * 这里只做解析，不做哈希、不碰数据库。
 */

export type BlockKind =
  | "heading"
  | "paragraph"
  | "code"
  | "quote"
  | "list"
  | "todo"
  | "table"
  /** 流程图 / 分支图：正文是图语法，界面上渲染成可点击的 SVG */
  | "diagram";

export interface ParsedBlock {
  seq: number;
  kind: BlockKind;
  text: string;
}

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?/;
const UL_RE = /^\s*[-*+]\s+/;
const OL_RE = /^\s*\d+[.)]\s+/;
const TODO_RE = /^\s*[-*+]\s+\[[ xX]\]\s+/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;

/**
 * 围栏的语言标记 → 块类型。
 *
 * 只有图语法需要特殊处理：把 ```diagram 围栏里的内容变成一个"图表块"，
 * 于是它在块列表里是一个独立单元，编辑时能拿到专门的预览。
 * 其余语言仍然走普通代码块，行为不变。
 */
const FENCE_KIND: Record<string, BlockKind> = {
  diagram: "diagram",
  graph: "diagram",
  flow: "diagram",
  图: "diagram",
  流程图: "diagram",
};

/** 从围栏信息串里取出语言标记（去掉多余参数，如 ```ts title=x） */
function fenceLanguage(info: string): string {
  return info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** 判断一行是否是块级结构的起始（段落遇到它就该断开） */
function startsBlock(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    QUOTE_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    TABLE_ROW_RE.test(line)
  );
}

/**
 * 解析 Markdown 为块序列。
 *
 * 幂等性要求：`serializeBlocks(parseMarkdown(md))` 必须稳定收敛 ——
 * 用户反复保存同一份内容不应产生新的块版本，否则缓存键会持续抖动。
 */
export function parseMarkdown(markdown: string): ParsedBlock[] {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const blocks: ParsedBlock[] = [];
  let seq = 0;

  const push = (kind: BlockKind, text: string) => {
    const trimmed = text.replace(/\s+$/, "");
    if (!trimmed.trim()) return; // 纯空白不产生块
    blocks.push({ seq: seq++, kind, text: trimmed });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // ---- 围栏代码块：内部一律不解析 ----
    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[2][0];
      const markerLen = fence[2].length;
      const info = fence[3] ?? "";
      const buf: string[] = [line];
      i += 1;
      while (i < lines.length) {
        buf.push(lines[i]);
        const closing = lines[i].match(FENCE_RE);
        const isClose = closing && closing[2][0] === marker && closing[2].length >= markerLen;
        i += 1;
        if (isClose) break;
      }
      /*
       * 图语法单独成一类块。
       *
       * 注意**整段围栏（含 ``` 首尾行）都保留在 text 里** —— 与代码块一致。
       * 这样序列化回 Markdown 时不需要任何额外处理，往返无损；
       * 图表组件自己负责剥掉围栏再解析内容。
       */
      push(FENCE_KIND[fenceLanguage(info)] ?? "code", buf.join("\n"));
      continue;
    }

    // ---- 标题 ----
    if (HEADING_RE.test(line)) {
      push("heading", line);
      i += 1;
      continue;
    }

    // ---- 表格 ----
    if (TABLE_ROW_RE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      push("table", buf.join("\n"));
      continue;
    }

    // ---- 引用 ----
    if (QUOTE_RE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length) {
        if (!lines[i].trim()) {
          // 引用块内的空行：只有下一行仍是引用才继续
          if (i + 1 < lines.length && QUOTE_RE.test(lines[i + 1])) {
            buf.push("");
            i += 1;
            continue;
          }
          break;
        }
        if (!QUOTE_RE.test(lines[i])) break;
        buf.push(lines[i]);
        i += 1;
      }
      push("quote", buf.join("\n"));
      continue;
    }

    // ---- 列表（含待办）----
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const isTodo = TODO_RE.test(line);

      /*
       * ⚠️ **每个顶层列表项单独成块**，而不是整个列表成一坨。
       *
       * 早先的实现把连续的所有列表行收进同一个块，于是
       * `- [ ] 甲\n- [ ] 乙\n- [ ] 丙` 变成**一个**块。后果很实际：
       *
       *   - 待办清单里的单项**无法单独 `@` 引用**，而复盘的勾选项、
       *     FAQ 的每一条，恰恰是最需要逐条挂进对话的东西；
       *   - 块级元信息（cacheKey、被引用次数）覆盖的是整坨，
       *     勾掉一条会让整坨的 cacheKey 变化；
       *   - 一坨 100 条的待办在预览里是一整块，点哪都选中全部。
       *
       * 判据与段落一致：**空行分隔的每个单元是一个知识块**。
       * 所以这里按"一项 + 它的缩进续行"切块。
       *
       * 注意相邻项之间**没有空行**时也切 —— 这是刻意的：
       * Markdown 里 `- a\n- b` 是两项，不是一项。
       * 往返无损不受影响：`serializeBlocks` 用 `\n\n` 连接，
       * 写回去仍然是合法列表（多一个空行而已，语义不变）。
       */
      const buf: string[] = [line];
      i += 1;
      while (i < lines.length) {
        const cur = lines[i];

        // 下一项（顶层标记）→ 本块结束，交给下一轮循环开新块
        if (UL_RE.test(cur) || OL_RE.test(cur)) break;

        // 缩进续行（2 空格以上的非空行）归入本项
        if (cur.trim() && /^\s{2,}/.test(cur)) {
          buf.push(cur);
          i += 1;
          continue;
        }

        // 空行：只有后面紧跟缩进续行时才继续吃（列表项内的松散写法）
        if (!cur.trim()) {
          const next = lines[i + 1];
          if (next !== undefined && next.trim() && /^\s{2,}/.test(next)) {
            buf.push("");
            i += 1;
            continue;
          }
          break;
        }

        // 其它任何行 → 本块结束
        break;
      }
      push(isTodo ? "todo" : "list", buf.join("\n"));
      continue;
    }

    // ---- 段落 ----
    const buf: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (!cur.trim()) break;
      if (startsBlock(cur)) break;
      buf.push(cur);
      i += 1;
    }
    if (buf.length > 0) {
      push("paragraph", buf.join("\n"));
    } else {
      // 兜底：本行无法归类，作为段落消费掉，保证循环一定推进（不死循环）
      push("paragraph", line);
      i += 1;
    }
  }

  return blocks;
}

/** 把块序列还原为 Markdown */
export function serializeBlocks(blocks: readonly { text: string }[]): string {
  return blocks
    .map((b) => b.text.replace(/\s+$/, ""))
    .filter((t) => t.trim())
    .join("\n\n");
}

/**
 * 计算每个块在文档中的标题路径，如 "部署手册 › 回滚流程"。
 *
 * 需要传入文档内**全部**块，而不只是被引用的那些 ——
 * 否则引用一个二级小节里的段落时算不出正确的父级路径。
 */
export function buildBlockPaths(
  docTitle: string,
  blocks: readonly { kind: BlockKind; text: string }[],
): string[] {
  const stack: string[] = [];
  return blocks.map((b) => {
    if (b.kind === "heading") {
      const m = b.text.match(HEADING_RE);
      const level = m ? m[1].length : 1;
      const title = m ? m[2].replace(/#+\s*$/, "").trim() : b.text.trim();
      stack.length = Math.max(0, level - 1);
      stack[level - 1] = title;
      // 标题块自身的路径是它的父级路径，避免出现 "X › X"
      const parents = stack.slice(0, level - 1).filter(Boolean);
      return [docTitle, ...parents].join(" › ");
    }
    return [docTitle, ...stack.filter(Boolean)].join(" › ");
  });
}

/** 块类型的中文标签 */
export const KIND_LABEL: Record<BlockKind, string> = {
  heading: "标题",
  paragraph: "正文",
  code: "代码",
  quote: "引用",
  list: "列表",
  todo: "待办",
  table: "表格",
  diagram: "图表",
};

/**
 * 规范化文本，用于哈希。
 *
 * 必须与组装器渲染块正文时用的规范化保持一致 ——
 * 否则会出现"内容看着没变但缓存键变了"的假失效。
 */
export function normalizeForHash(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}
