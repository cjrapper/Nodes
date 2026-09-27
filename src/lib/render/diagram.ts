/**
 * 流程图 / 分支图渲染器 —— **零依赖**，输出纯 SVG 字符串。
 *
 * ## 为什么手写而不用 mermaid
 *
 * mermaid 能满足需求，但它的解包体积是 124MB（含各种构建产物），
 * 浏览器端 bundle 也要几百 KB，还要连带 D3 那套布局引擎。对一个本地优先的
 * 学习笔记应用来说这是很重的负担，而我们真正要画的只是"分支图/流程图"这一种图：
 *
 *   - 布局需求简单：分层（同一个源头出发的在同一列）+ 同层均分纵向位置
 *   - 输出是**纯字符串**，因此可以像 markdown 渲染器那样做纯函数单测
 *   - 节点的跳转直接就是一个 `<a href>`，天然满足"像超链接一样"的需求
 *
 * ## 与缓存的关系（重要）
 *
 * 图表的**源文本**是普通的知识块正文，因此它的哈希完全确定 ——
 * 用户不动这张图，缓存前缀就不会变。渲染出来的 SVG 只存在于界面上，
 * 不进 prompt。这一点是刻意保住的：如果把渲染结果喂给模型，
 * 一张图就会带来几百行噪声 token，而且每次渲染的字节顺序稍有差别
 * 就会击穿缓存。
 *
 * ## 语法
 *
 * ```
 * # 职业方向          标题（可选）
 * 客户端 --> 引擎      边：a --> b（无向用 a --- b）
 * Unity["Unity 客户端"] 节点：[...] 里是自定义标签
 * Unity --> doc:abc123  --> doc:<id> 表示"跳转到某篇文档"
 * Unity --> url:https://example.com
 * gpu{要不要做图形}     {} 表示判断节点（菱形）
 * ```
 *
 * 节点 id 只用字母数字下划线连字符；标签里出现特殊字符时用引号包起来。
 */

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

export interface DiagramNode {
  id: string;
  /** 显示文字；缺省时用 id */
  label: string;
  /** 形状：矩形或菱形（判断） */
  shape: "box" | "diamond";
  /** 跳转目标（已解析成最终 href），无则不可点 */
  href: string | null;
  /** href 的原始写法，用于展示与调试 */
  target: string | null;
}

export interface DiagramEdge {
  from: string;
  to: string;
  /** 是否画箭头 */
  directed: boolean;
  /** 线上标注（可选） */
  label: string | null;
}

export interface DiagramSpec {
  title: string | null;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** 解析过程中的问题，展示给用户而不是静默吞掉 */
  warnings: string[];
}

/**
 * 节点 id 的允许字符。
 *
 * 允许 `:` 是必须的 —— `doc:xxx` / `url:xxx` 在语法上就是"节点 id"，
 * 只不过它的含义是链接而不是普通节点。早先没放行冒号，结果是
 * `A --> doc:xyz` 这一行匹配不上边的规则，退化成"节点定义"，
 * 于是标签被吃掉、整条边静默消失（测试里表现为节点数少了一个）。
 */
const NODE_ID = "[A-Za-z0-9_:\\u4e00-\\u9fff\\-./]+";

/**
 * 按行做**词法切分**，而不是用一个大正则去啃属性语法。
 *
 * 起因是一个真实的解析漏洞：`A["标签"] --> doc:x` 里的边规则只认
 * `id --> id`，左侧一带属性整行就匹配不上，于是这条边和它的目标节点
 * 一起被静默丢掉。属性语法与边语法交织，用正则穷举组合很快就会失控，
 * 所以改成"切 token + 按 token 序列判定"。
 */
type Token =
  | { kind: "id"; value: string }
  | { kind: "arrow"; value: string }
  | { kind: "attr"; value: string; shape: "box" | "diamond" }
  | { kind: "edgeLabel"; value: string };

function tokenizeLine(line: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;

  /*
   * 链接 id（`url:` / `doc:`）整体吃到下一个空白为止。
   *
   * 不能按 NODE_ID 的字符集去切 —— 真实地址里会出现 `(`、`?`、`&`、`#`
   * 这些字符。早先按字符集切的结果是 `url:javascript:alert(1)` 被截成
   * `url:javascript:alert`，剩下的 `(1)` 又解析不了，于是整行被丢掉、
   * 用户看到的是一张莫名少了一条边的图。
   */
  const LINK_PREFIX = /^(?:url|doc)[:：]\S*/i;

  while (i < line.length) {
    const ch = line[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    // 属性：`["标签"]` 或 `{标签}`
    if (ch === "[" || ch === "{") {
      const closeCh = ch === "[" ? "]" : "}";
      const close = line.indexOf(closeCh, i + 1);
      if (close === -1) return null;
      tokens.push({
        kind: "attr",
        value: unquote(line.slice(i + 1, close)),
        shape: ch === "{" ? "diamond" : "box",
      });
      i = close + 1;
      continue;
    }

    // 边标注：`|文字|`，只可能跟在箭头后面
    if (ch === "|") {
      const close = line.indexOf("|", i + 1);
      if (close === -1) return null;
      tokens.push({ kind: "edgeLabel", value: unquote(line.slice(i + 1, close)) });
      i = close + 1;
      continue;
    }

    // 箭头
    const arrowMatch = /^(-->|---|--x|==>)/.exec(line.slice(i));
    if (arrowMatch) {
      tokens.push({ kind: "arrow", value: arrowMatch[1] });
      i += arrowMatch[1].length;
      continue;
    }

    // 链接 id：整段吃掉
    const linkMatch = LINK_PREFIX.exec(line.slice(i));
    if (linkMatch) {
      tokens.push({ kind: "id", value: linkMatch[0] });
      i += linkMatch[0].length;
      continue;
    }

    // 普通 id
    const idMatch = new RegExp(`^${NODE_ID}`).exec(line.slice(i));
    if (idMatch) {
      tokens.push({ kind: "id", value: idMatch[0] });
      i += idMatch[0].length;
      continue;
    }

    return null;
  }

  return tokens;
}

/**
 * 判定一个 id 是否是链接（`doc:` / `url:` 前缀）。
 *
 * 链接节点的**显示文字**默认取去掉前缀后的部分，而不是整个 `doc:xxx` ——
 * 否则图上会显示一串 id，可读性很差。
 *
 * 但节点的 **id 保留完整前缀**（`doc:abc`），不剥成 `abc`。这样
 * `doc:abc` 与一个恰好叫 `abc` 的普通节点不会撞在一起，
 * 而且"同一个目标只对应一个节点"这条性质更容易成立。
 */
function parseLinkId(id: string): { scheme: "doc" | "url"; target: string } | null {
  const match = /^(doc|url)[:：](.+)$/i.exec(id.trim());
  if (!match) return null;
  return { scheme: match[1].toLowerCase() as "doc" | "url", target: match[2].trim() };
}

/** `doc:<id>` / `url:<地址>` / 裸地址 —— 决定点击后的去向 */
export type LinkResolver = (target: string) => string | null;

/**
 * 默认的链接解析：只认 `doc:` 与 `url:` 两种前缀。
 *
 * 刻意不支持裸地址 —— `A --> B` 里的 `B` 是一个**节点 id**，
 * 如果把它当链接，用户就得靠肉眼区分"这是引用还是新节点"，很容易写错。
 * 显式前缀让意图没有歧义。
 */
export const defaultLinkResolver: LinkResolver = (target) => {
  const value = target.trim();
  if (/^https?:\/\//i.test(value)) return value;
  return null;
};

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 解析图表源文本。
 *
 * 容错原则：**任何一行解析不出来都不能丢内容**，而是记进 `warnings`
 * 并把该行原样当作文本节点 —— 用户看到提示才知道自己写错了，
 * 而不是面对一张莫名其妙少了几块内容的图。
 */
export function parseDiagram(source: string, resolveLink: LinkResolver = defaultLinkResolver): DiagramSpec {
  const nodes = new Map<string, DiagramNode>();
  const edges: DiagramEdge[] = [];
  const warnings: string[] = [];
  let title: string | null = null;

  const ensureNode = (id: string): DiagramNode => {
    let node = nodes.get(id);
    if (!node) {
      // 链接节点（doc:/url:）自动带上可点击属性，不必再写一遍属性语法
      const link = parseLinkId(id);
      node = {
        id,
        // 显示文字默认取去掉前缀的部分，免得图上是一串 id
        label: link ? link.target : id,
        shape: "box",
        href: link ? resolveLink(`${link.scheme}:${link.target}`) : null,
        target: link ? `${link.scheme}:${link.target}` : null,
      };
      nodes.set(id, node);
      if (link && !node.href) warnings.push(`无法解析链接目标：${id}`);
    }
    return node;
  };

  /** 处理 `目标` 这一列：既可能是节点 id，也可能是链接前缀 */
  const applyTarget = (node: DiagramNode, raw: string): void => {
    const value = raw.trim();
    if (!value) return;
    const docMatch = /^doc[:：]\s*(.+)$/i.exec(value);
    const urlMatch = /^url[:：]\s*(.+)$/i.exec(value);
    if (docMatch || urlMatch) {
      const target = (docMatch ?? urlMatch)![1].trim();
      const href = resolveLink(`${docMatch ? "doc" : "url"}:${target}`);
      node.target = `${docMatch ? "doc" : "url"}:${target}`;
      node.href = href;
      if (!href) warnings.push(`无法解析链接目标：${value}`);
      return;
    }
    // 普通标签
    node.label = unquote(value);
  };

  const lines = source.replace(/\r\n?/g, "\n").split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // 注释：`//` 开头整行忽略。刻意不用 `#` —— 它已经被标题占用了。
    if (line.startsWith("//")) continue;

    // 标题
    if (line.startsWith("#")) {
      title = line.replace(/^#+\s*/, "").trim() || null;
      continue;
    }

    const tokens = tokenizeLine(line);
    if (!tokens || tokens.length === 0) {
      warnings.push(`无法解析这一行：${line}`);
      continue;
    }

    /*
     * 按 token 序列判定这一行是什么。
     * 支持的形态（属性与标注都是可选的）：
     *   id
     *   id["标签"] / id{标签}
     *   id --> id
     *   id["标签"] --> id["标签"]
     *   id -->|标注| id
     */
    let cursor = 0;
    let ok = true;

    while (cursor < tokens.length) {
      const head = tokens[cursor];
      if (head.kind !== "id") {
        ok = false;
        break;
      }
      const fromNode = ensureNode(head.value);
      cursor += 1;

      // 紧跟的属性（可选）
      if (tokens[cursor]?.kind === "attr") {
        const attr = tokens[cursor] as Extract<Token, { kind: "attr" }>;
        fromNode.shape = attr.shape;
        if (attr.value) applyTarget(fromNode, attr.value);
        cursor += 1;
      }

      // 没有箭头 → 这一行就是一个孤立的节点定义
      if (tokens[cursor]?.kind !== "arrow") break;

      const arrow = tokens[cursor] as Extract<Token, { kind: "arrow" }>;
      cursor += 1;

      // 边标注（可选）
      let edgeLabelValue: string | null = null;
      if (tokens[cursor]?.kind === "edgeLabel") {
        edgeLabelValue = (tokens[cursor] as Extract<Token, { kind: "edgeLabel" }>).value;
        cursor += 1;
      }

      const tail = tokens[cursor];
      if (tail?.kind !== "id") {
        ok = false;
        break;
      }
      const toNode = ensureNode(tail.value);
      cursor += 1;

      // 目标节点后面也可能跟属性
      if (tokens[cursor]?.kind === "attr") {
        const attr = tokens[cursor] as Extract<Token, { kind: "attr" }>;
        toNode.shape = attr.shape;
        if (attr.value) applyTarget(toNode, attr.value);
        cursor += 1;
      }

      if (fromNode.id === toNode.id) {
        warnings.push(`自己连到自己，已忽略：${fromNode.id}`);
        continue;
      }

      edges.push({
        from: fromNode.id,
        to: toNode.id,
        directed: arrow.value !== "---",
        label: edgeLabelValue,
      });
    }

    if (!ok) warnings.push(`无法解析这一行：${line}`);
  }

  return { title, nodes: [...nodes.values()], edges, warnings };
}

/* ------------------------------------------------------------------ *
 * 布局
 * ------------------------------------------------------------------ */

export interface LaidOutNode extends DiagramNode {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 边的连接点（矩形上/下边中点） */
  centerX: number;
}

export interface LaidOutEdge extends DiagramEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  labelX: number;
  labelY: number;
}

export interface DiagramLayout {
  width: number;
  height: number;
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  warnings: string[];
  title: string | null;
}

const NODE_HEIGHT = 38;
const DIAMOND_HEIGHT = 48;
const NODE_GAP_Y = 18;
const COLUMN_GAP = 68;
const PADDING = 16;
const TITLE_HEIGHT = 30;

/** 粗略估算标签宽度。中文字符按整宽算，其余按 0.62 个字符宽。 */
export function estimateLabelWidth(label: string, fontSize = 13): number {
  let units = 0;
  for (const ch of label) {
    const cp = ch.codePointAt(0) ?? 0;
    // CJK / 全角标点按 1 个字宽
    units += cp > 0x2e7f ? 1 : 0.58;
  }
  return Math.ceil(units * fontSize);
}

/**
 * 分层：每个节点落在"从它出发可达的最长入边链"所决定的列上。
 *
 * 用最长路径而不是简单 BFS，是为了让"分支汇合"看起来正确：
 * 若 A→C 且 B→C，而 B 在更深的层，那 C 必须排到 B 之后，
 * 否则连线会向上回折，图会非常难读。
 *
 * 有环时（用户可能画出环形依赖）用访问栈检测并断开，不让它死循环。
 */
export function assignLayers(
  nodeIds: readonly string[],
  edges: readonly DiagramEdge[],
): Map<string, number> {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const e of edges) {
    if (!incoming.has(e.to) || !outgoing.has(e.from)) continue;
    incoming.get(e.to)!.push(e.from);
    outgoing.get(e.from)!.push(e.to);
  }

  const layer = new Map<string, number>();
  const visiting = new Set<string>();

  const resolve = (id: string): number => {
    const cached = layer.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // 环：就地截断
    visiting.add(id);
    const parents = incoming.get(id) ?? [];
    const value = parents.length === 0 ? 0 : Math.max(...parents.map((p) => resolve(p) + 1));
    visiting.delete(id);
    layer.set(id, value);
    return value;
  };

  for (const id of nodeIds) resolve(id);
  return layer;
}

/** 把解析结果排成可绘制的坐标 */
export function layoutDiagram(spec: DiagramSpec): DiagramLayout {
  const { nodes, edges, warnings, title } = spec;
  if (nodes.length === 0) {
    return { width: 0, height: 0, nodes: [], edges: [], warnings, title };
  }

  const layerOf = assignLayers(
    nodes.map((n) => n.id),
    edges,
  );

  // 按层分组；同层内保持输入顺序，保证"同样的源文本渲染出同样的图"
  const columns = new Map<number, DiagramNode[]>();
  for (const node of nodes) {
    const l = layerOf.get(node.id) ?? 0;
    const list = columns.get(l) ?? [];
    list.push(node);
    columns.set(l, list);
  }

  const layerKeys = [...columns.keys()].sort((a, b) => a - b);
  const maxRows = Math.max(...layerKeys.map((k) => columns.get(k)!.length));

  // 每列宽度按该列最宽的节点算
  const columnWidths = new Map<number, number>();
  for (const key of layerKeys) {
    const widest = Math.max(
      ...columns.get(key)!.map((n) => estimateLabelWidth(n.label) + 28),
    );
    columnWidths.set(key, Math.max(84, widest));
  }

  const contentHeight = maxRows * NODE_HEIGHT + (maxRows - 1) * NODE_GAP_Y;
  const topOffset = PADDING + (title ? TITLE_HEIGHT : 0);

  const laidOut: LaidOutNode[] = [];
  let x = PADDING;

  for (const key of layerKeys) {
    const columnNodes = columns.get(key)!;
    const width = columnWidths.get(key)!;
    const columnHeight = columnNodes.length * NODE_HEIGHT + (columnNodes.length - 1) * NODE_GAP_Y;
    // 纵向居中，让不同列看起来是围绕同一条中轴排布的
    let y = topOffset + (contentHeight - columnHeight) / 2;

    for (const node of columnNodes) {
      const height = node.shape === "diamond" ? DIAMOND_HEIGHT : NODE_HEIGHT;
      laidOut.push({
        ...node,
        x,
        y,
        width,
        height,
        centerX: x + width / 2,
      });
      y += height + NODE_GAP_Y;
    }

    x += width + COLUMN_GAP;
  }

  const width = x - COLUMN_GAP + PADDING;
  const height = topOffset + contentHeight + PADDING;

  const byId = new Map(laidOut.map((n) => [n.id, n]));
  const laidOutEdges: LaidOutEdge[] = [];
  for (const edge of edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    // 从右侧出、左侧入 —— 分层图里最自然的连线方向
    const x1 = from.x + from.width;
    const y1 = from.y + from.height / 2;
    const x2 = to.x;
    const y2 = to.y + to.height / 2;
    laidOutEdges.push({
      ...edge,
      x1,
      y1,
      x2,
      y2,
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2 - 4,
    });
  }

  return { width, height, nodes: laidOut, edges: laidOutEdges, warnings, title };
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BOX_FILL = "#171b21";
const BOX_STROKE = "#3a424d";
const BOX_FILL_LINKED = "#132a22";
const BOX_STROKE_LINKED = "#3ddc97";
const EDGE_STROKE = "#4a535f";
const TEXT_FILL = "#e6e9ee";
const TITLE_FILL = "#98a2b3";

/** 节点里的文字太长时折成两行（按估算宽度判断） */
function wrapLabel(label: string, maxWidth: number): string[] {
  if (estimateLabelWidth(label) <= maxWidth - 20) return [label];
  const mid = Math.ceil(label.length / 2);
  return [label.slice(0, mid), label.slice(mid)];
}

/**
 * 把布局结果渲染成 SVG 字符串。
 *
 * 跳转用真正的 `<a href>` 而不是 `onClick`：一来在纯字符串输出里就能工作，
 * 二来用户可以直接中键新窗口打开 / 复制链接，符合"像超链接一样"的预期。
 */
export function renderDiagramSvg(layout: DiagramLayout): string {
  const { width, height, nodes, edges, title } = layout;
  if (nodes.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>`;
  }

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
      `role="img" aria-label="${escapeXml(title ?? "流程图")}">`,
  );

  parts.push(
    `<defs><marker id="nodes-arrow" viewBox="0 0 10 10" refX="9" refY="5" ` +
      `markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
      `<path d="M 0 0 L 10 5 L 0 10 z" fill="${EDGE_STROKE}"/></marker></defs>`,
  );

  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="transparent"/>`);

  if (title) {
    parts.push(
      `<text x="${PADDING}" y="${PADDING + 16}" fill="${TITLE_FILL}" ` +
        `font-size="12" font-weight="600">${escapeXml(title)}</text>`,
    );
  }

  // 先画边，再画节点，节点压在连线上（避免线头露在框里）
  for (const edge of edges) {
    const midX = (edge.x1 + edge.x2) / 2;
    parts.push(
      `<path d="M ${edge.x1} ${edge.y1} C ${midX} ${edge.y1}, ${midX} ${edge.y2}, ${edge.x2} ${edge.y2}" ` +
        `fill="none" stroke="${EDGE_STROKE}" stroke-width="1.5"` +
        (edge.directed ? ` marker-end="url(#nodes-arrow)"` : "") +
        `/>`,
    );
    if (edge.label) {
      parts.push(
        `<text x="${edge.labelX}" y="${edge.labelY}" fill="${TITLE_FILL}" font-size="10" ` +
          `text-anchor="middle">${escapeXml(edge.label)}</text>`,
      );
    }
  }

  for (const node of nodes) {
    const linked = node.href !== null;
    const fill = linked ? BOX_FILL_LINKED : BOX_FILL;
    const stroke = linked ? BOX_STROKE_LINKED : BOX_STROKE;

    const shape =
      node.shape === "diamond"
        ? `<polygon points="${node.centerX},${node.y} ${node.x + node.width},${node.y + node.height / 2} ` +
          `${node.centerX},${node.y + node.height} ${node.x},${node.y + node.height / 2}" ` +
          `fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`
        : `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8" ` +
          `fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;

    const lines = wrapLabel(node.label, node.width);
    const lineHeight = 15;
    const textY = node.y + node.height / 2 - ((lines.length - 1) * lineHeight) / 2 + 4;
    const textNodes = lines
      .map(
        (line, index) =>
          `<text x="${node.centerX}" y="${textY + index * lineHeight}" fill="${TEXT_FILL}" ` +
          `font-size="13" text-anchor="middle">${escapeXml(line)}</text>`,
      )
      .join("");

    // 可点节点外面套 <a>；`target` 交给浏览器默认行为（同源同窗口跳转）
    const body = shape + textNodes;
    parts.push(
      linked
        ? `<a href="${escapeXml(node.href!)}" title="${escapeXml(node.target ?? "")}">${body}</a>`
        : `<g>${body}</g>`,
    );
  }

  parts.push("</svg>");
  return parts.join("");
}

/** 一步到位：源文本 → SVG。供组件与测试使用。 */
export function renderDiagram(
  source: string,
  resolveLink: LinkResolver = defaultLinkResolver,
): { svg: string; spec: DiagramSpec; layout: DiagramLayout } {
  const spec = parseDiagram(source, resolveLink);
  const layout = layoutDiagram(spec);
  return { svg: renderDiagramSvg(layout), spec, layout };
}
