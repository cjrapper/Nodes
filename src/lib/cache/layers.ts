/**
 * 上下文分层定义。
 *
 * 这是整个缓存优化策略的**单一事实来源**：所有影响 prompt 文本的
 * 渲染逻辑都集中在这里，且必须满足"纯函数 + 确定性"——
 * 同样的输入永远产出逐字节相同的输出。
 *
 * 任何在本文件里引入 `Date.now()` / `Math.random()` / 迭代 Map 原序
 * 的改动，都会直接摧毁缓存命中率。改动前请先读 DESIGN.md 第 2 节。
 */

import { KIND_LABEL, type BlockKind } from "../blocks/parse-blocks";
import { estimateTokens } from "../tokens";

export { KIND_LABEL };

/** 上下文层，按稳定性从高到低排列（数组顺序即 prompt 中的出现顺序） */
export const LAYER_ORDER = [
  "L0_persona",
  "L1_workspace",
  "L2_source_index",
  "L2_source_content",
  "L2_doc_index",
  "L2_doc_content",
  "L3_history",
  "L4_turn",
] as const;

export type LayerName = (typeof LAYER_ORDER)[number];

/** 稳定性等级仅用于 UI 着色与断点预算排序 */
export type Stability = "static" | "low" | "medium" | "append-only" | "volatile";

export interface LayerMeta {
  name: LayerName;
  title: string;
  stability: Stability;
  /** 该层是否适合作为 Anthropic 缓存断点（断点必须落在系统提示的稳定部分之后） */
  breakpointCandidate: boolean;
  /** 面向用户的一句话解释，显示在缓存仪表盘上 */
  hint: string;
}

export const LAYER_META: { [K in LayerName]: LayerMeta } = {
  L0_persona: {
    name: "L0_persona",
    title: "L0 身份内核",
    stability: "static",
    breakpointCandidate: true,
    hint: "人设与输出契约。只有修改人设时才会失效。",
  },
  L1_workspace: {
    name: "L1_workspace",
    title: "L1 工作区约定",
    stability: "low",
    breakpointCandidate: true,
    hint: "术语表与写作约定。低频变更，变更只影响本层之后。",
  },
  L2_source_index: {
    name: "L2_source_index",
    title: "L2 引用清单",
    stability: "medium",
    breakpointCandidate: false,
    hint: "被 @ 的知识块目录。只列标题与位置，保证即便正文被裁剪清单依然稳定。",
  },
  L2_source_content: {
    name: "L2_source_content",
    title: "L2 知识块正文",
    stability: "medium",
    breakpointCandidate: true,
    hint: "被 @ 的知识块全文，按内容哈希稳定排序，与 @ 的先后顺序无关。",
  },
  L2_doc_index: {
    name: "L2_doc_index",
    title: "L2 模块清单",
    stability: "medium",
    breakpointCandidate: false,
    hint: "被挂载的整篇文档/模块目录。只列标题与规模，保证正文被裁剪时清单依然稳定。",
  },
  L2_doc_content: {
    name: "L2_doc_content",
    title: "L2 模块正文",
    stability: "medium",
    breakpointCandidate: true,
    hint: "整篇文档/模块的内容，按文档稳定键排序。用于「查漏补缺」这类需要看全局的任务。",
  },
  L3_history: {
    name: "L3_history",
    title: "L3 对话历史",
    stability: "append-only",
    breakpointCandidate: true,
    hint: "只追加、从不改写。追加式增长是缓存最友好的形态。",
  },
  L4_turn: {
    name: "L4_turn",
    title: "L4 本轮输入",
    stability: "volatile",
    breakpointCandidate: false,
    hint: "本轮提问与临时指令。唯一每轮都变的部分，放在最末尾。",
  },
};

/** 一个被引用的知识块（已从库里读出并规范化） */
export interface SourceBlock {
  id: string;
  docId: string;
  seq: number;
  kind: BlockKind;
  text: string;
  /** 内容哈希，来自 block.text_hash */
  textHash: string;
  /** 稳定排序键：sha256(textHash + id) 前 16 位 */
  cacheKey: string;
  docTitle: string;
  /** 文档内的标题路径，如 "部署手册 › 回滚流程" */
  path: string;
}

/**
 * 一篇被整体挂载的文档（或模块）。
 *
 * 与 `SourceBlock` 的区别是**粒度**：块级引用适合"就这几段回答我"，
 * 整篇挂载适合"看看这个方向我整理得怎么样"。
 * 用户要的「查漏补缺」「评判修改」都属于后者 —— 只看几段是判断不出
 * 哪里缺失的。
 */
export interface SourceDoc {
  docId: string;
  title: string;
  kind: "doc" | "module";
  /** 文档内全部块的正文，已按 seq 排序、已规范化 */
  blocks: { kind: BlockKind; text: string }[];
  /** 内容哈希：由全部块的哈希按序合成。任一块变了它就变 */
  textHash: string;
  /** 稳定排序键：sha256(textHash + docId) 前 16 位 */
  cacheKey: string;
  /** 这篇文档自身的知识块数量 */
  blockCount: number;
}

/**
 * 整篇文档的稳定排序。与块级排序同理：挂载顺序无关，内容决定位置。
 */
export function sortDocsDeterministically(docs: readonly SourceDoc[]): SourceDoc[] {
  return [...docs].sort((a, b) => {
    if (a.cacheKey < b.cacheKey) return -1;
    if (a.cacheKey > b.cacheKey) return 1;
    if (a.docId < b.docId) return -1;
    if (a.docId > b.docId) return 1;
    return 0;
  });
}

/**
 * 渲染模块清单。
 *
 * 与块级清单同理：**只依赖"挂了哪些文档"，不依赖文档内容**。
 * 列出整体规模（块数）会让编辑正文时清单跟着变，把失效层从正文
 * 上浮到清单 —— 这个坑在块级清单上已经踩过一次，这里不重复。
 */
export function renderDocIndex(docs: readonly SourceDoc[]): string {
  if (docs.length === 0) return "";
  const sorted = sortDocsDeterministically(docs);
  const lines = sorted.map((d) => {
    const label = d.kind === "module" ? "模块" : "文档";
    return `- \`${d.cacheKey.slice(0, 8)}\` [${label}] ${d.title}`;
  });
  return [
    `# 已挂载的模块清单`,
    ``,
    `共 ${sorted.length} 个整体挂载的文档/模块。正文见下一节。`,
    ``,
    ...lines,
  ].join("\n");
}

/**
 * 渲染模块正文。
 *
 * 每篇文档内部保留它自己的标题结构（`##` 之类原样输出），
 * 这样模型能看出文档内部的组织方式 —— 判断"这个方向整理得怎么样"时，
 * 结构本身就是重要信息。
 */
export function renderDocContent(docs: readonly SourceDoc[], budgetTokens: number): string {
  if (docs.length === 0) return "";
  const sorted = sortDocsDeterministically(docs);

  const sections: string[] = [
    `# 模块正文`,
    ``,
    `<!-- 以下文档按内容哈希稳定排序，顺序与挂载先后无关 -->`,
  ];

  let used = 0;
  let truncated = 0;

  for (const doc of sorted) {
    const header = `\n<<<DOC ${doc.cacheKey.slice(0, 8)} | ${doc.title}>>>`;
    const cost = estimateTokens(header) + doc.blocks.reduce((s, b) => s + estimateTokens(b.text), 0);

    // 预算不够就跳过整篇，而不是切一半 —— 半个知识点比没有更容易误导模型
    if (used + cost > budgetTokens && used > 0) {
      truncated += 1;
      sections.push(`\n<<<DOC ${doc.cacheKey.slice(0, 8)} | ${doc.title}>>>（因长度限制未展开）`);
      continue;
    }

    sections.push(header);
    for (const block of doc.blocks) {
      sections.push(normalizeBlockText(block.text));
    }
    sections.push(`<<<END DOC>>>`);
    used += cost;
  }

  if (truncated > 0) {
    sections.push(
      ``,
      `<!-- 有 ${truncated} 篇文档因超出预算未展开正文，清单里仍然列出了它们 -->`,
    );
  }

  return sections.join("\n");
}

/**
 * 正文块文本规范化。**必须幂等且无信息损失**：
 * 任何有损处理都会让同一逻辑内容产生不同字节，从而分裂缓存前缀。
 */
export function normalizeBlockText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n") // 统一换行符
    .replace(/[ \t]+$/gm, "") // 去掉行尾空白
    .replace(/\n{3,}/g, "\n\n") // 三个以上连续空行折叠为两个
    .replace(/^\n+/, "") // 去掉首部空行
    .replace(/\s+$/, ""); // 去掉尾部空白
}

/**
 * 知识块的稳定排序。
 *
 * 这是缓存命中率的关键：用户按什么顺序点选 @ 完全不重要，
 * 同一组块永远渲染成同一段文本。
 * 用 localeCompare 会随 ICU 版本漂移，因此这里用**码点比较**。
 */
export function sortBlocksDeterministically(blocks: readonly SourceBlock[]): SourceBlock[] {
  return [...blocks].sort((a, b) => {
    if (a.cacheKey < b.cacheKey) return -1;
    if (a.cacheKey > b.cacheKey) return 1;
    // cacheKey 相同意味着内容与 id 都相同，理论上不会发生；兜底保证全序
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

/*
 * 块类型的中文标签统一从解析模块导入（见文件顶部的 import）。
 * 这里原本另写了一份，加 `diagram` 类型时就漏了这一处 ——
 * 凡是"按 BlockKind 穷举"的映射，都应该只有一份定义。
 */

/**
 * 渲染 L0 身份内核。
 *
 * ## 三个刻意的决定
 *
 * ### 1. 有自定义人设时，**不再写死角色说明**
 *
 * 原先无论用户填什么，开头都固定拼一句
 * 「你是「XX」这个知识库的写作与分析助手。」
 * 而用户的人设可能是「游戏开发面试陪练」「代码评审员」—— 两句话直接打架，
 * 模型会倾向于服从更靠前、更"像系统指令"的那句，于是用户精心写的定位
 * 被一个模板句稀释掉了。
 *
 * 所以：人设为空时才用兜底的角色说明；非空时完全交给用户，
 * 工作区名只作为一句事实性上下文附加。
 *
 * ### 2. 输出契约**不能**禁止模型使用自己的知识
 *
 * 原契约写的是「只依据提供的知识块内容作答；知识块里没有的信息，
 * 明确说明"知识块中未涵盖"，不要编造」。这句话对"根据笔记回答问题"是对的，
 * 但它和本工具**最主要的用法直接冲突** ——
 *
 *   用户点「AI 分析」，要的正是"这个模块还缺什么"。
 *   而"缺什么"**必然在知识块之外**。按原契约，模型只能回答"知识块中未涵盖"，
 *   于是这个功能从设计上就被自己的提示词否决了。
 *
 * 正确的划界不是"禁止知识块之外的信息"，而是**区分事实与判断**：
 *  - 事实要可核查：引用笔记内容、引用外部资料，都必须说清来源；
 *  - 判断（缺口、错误、过时、易错点）本来就是模型的职责，应当给，
 *    但必须标明这是判断而非笔记原文；
 *  - **不得编造具体事实**（API 签名、版本行为、性能数字），
 *    不确定就说不确定。
 *
 * 三者分开之后，「查漏补缺」才有了合法空间，同时"不要编造"这条底线
 * 反而更清晰 —— 因为它现在只针对事实，不再和"指出缺口"混为一谈。
 *
 * ### 3. 契约放在最后
 *
 * 提示词的末尾对生成行为影响更大。契约是"怎么输出"，人设是"你是谁"，
 * 先身份后规则更符合直觉；而且契约固定不变，放末尾也不影响前缀稳定性
 * （整段都是 L0，要么一起命中要么一起失效）。
 */
export function renderPersona(persona: string, workspaceName: string): string {
  const trimmed = persona.trim();

  /*
   * 人设为空才给角色说明。
   *
   * 非空时**一句角色话都不加** —— 包括"你服务于 XX 知识库"这种看起来无害的
   * 上下文：它既可能和人设重复（用户自己写了"知识库助手"就是两遍），
   * 也可能和人设冲突（用户写的是"面试陪练"，凭什么叫它知识库助手）。
   * 工作区名对人设没有信息量，省掉比写一句别扭的强。
   */
  const identity = trimmed
    ? [`# 你的身份`, ``, trimmed]
    : [`# 你的身份`, ``, `你是「${workspaceName}」的助手。`];

  return [
    ...identity,
    ``,
    `# 输出契约`,
    ``,
    `- 直接给结论，不要复述问题，不要写"根据您提供的资料"这类套话。`,
    `- 引用知识块里的内容时，用「文档名 › 小节」的形式标注来源。`,
    `- 你的专业判断（缺失的主题、错误、过时信息、易错点、面试会追问的方向）`,
    `  是本职工作的核心，**不受"只依据知识块"的限制** —— 该说就说。`,
    `- 但要**分清哪些是笔记里的、哪些是你的判断**。混在一起用户无法核对。`,
    `- **不要编造具体事实**：API 签名、版本行为、性能数字这类东西如果不确定，`,
    `  直接说不确定并指出该去哪里验证。宁可说不知道，也不要给一个听起来合理的答案。`,
    `- 输出使用简体中文，Markdown 格式。`,
  ].join("\n");
}

/** 渲染 L1 工作区约定 */
export function renderWorkspace(conventions: string): string {
  const trimmed = conventions.trim();
  if (!trimmed) return "";
  return [`# 工作区约定`, ``, trimmed].join("\n");
}

/**
 * 渲染 L2 引用清单（不含正文）。
 *
 * 这里的每一项都刻意保持**只依赖块的集合，不依赖块的内容**：
 * 只有 `cacheKey` 前 8 位与标题路径，不含 token 数、不含"是否已展开"标记。
 *
 * 原因是实测出来的教训 —— 早先版本在清单里写了每个块的 token 数，
 * 结果编辑任一块的正文都会让 token 数变化，清单跟着变，
 * 于是失效层从"L2 正文"上浮到"L2 清单"，把整层缓存的收益一起吃掉了。
 * 现在编辑块内容只影响正文层，清单层保持命中。
 */
export function renderSourceIndex(blocks: readonly SourceBlock[]): string {
  if (blocks.length === 0) return "";
  const sorted = sortBlocksDeterministically(blocks);
  const lines = sorted.map((b) => `- \`${b.cacheKey.slice(0, 8)}\` [${b.path}] ${KIND_LABEL[b.kind]}`);
  return [
    `# 已挂载的知识块清单`,
    ``,
    `共 ${sorted.length} 个块，正文见下一节，按块标识排序。`,
    ``,
    ...lines,
  ].join("\n");
}

/** 渲染 L2 知识块正文 */
export function renderSourceContent(
  blocks: readonly SourceBlock[],
  omittedIds: ReadonlySet<string>,
): string {
  const sorted = sortBlocksDeterministically(blocks).filter((b) => !omittedIds.has(b.id));
  if (sorted.length === 0) return "";

  const sections: string[] = [
    `# 知识块正文`,
    ``,
    `<!-- 以下块按内容哈希稳定排序，顺序与引用先后无关 -->`,
  ];

  for (const b of sorted) {
    const body = normalizeBlockText(b.text);
    sections.push(
      ``,
      `<<<BLOCK ${b.cacheKey.slice(0, 8)} | ${b.path} | ${KIND_LABEL[b.kind]}>>>`,
      body,
      `<<<END BLOCK>>>`,
    );
  }

  return sections.join("\n");
}

/**
 * 在 token 预算内挑选要展开正文的块。
 *
 * 策略：按稳定排序顺序**尽可能多地**纳入，剩余的打上 omitted 标记。
 * 之所以不按"相关性"挑选，是因为相关性会随问题变化 ——
 * 那会让 L2 每轮都不同，缓存直接归零。宁可少放，也要稳定。
 */
export function selectBlocksWithinBudget(
  blocks: readonly SourceBlock[],
  budgetTokens: number,
): { included: SourceBlock[]; omittedIds: Set<string> } {
  const sorted = sortBlocksDeterministically(blocks);
  const included: SourceBlock[] = [];
  const omittedIds = new Set<string>();
  let used = 0;

  for (const b of sorted) {
    const cost = estimateTokens(b.text) + 24; // 含块头开销
    if (used + cost > budgetTokens && included.length > 0) {
      omittedIds.add(b.id);
      continue;
    }
    // 第一个块即使超预算也要放进来，否则上下文变成空的，模型无从作答
    included.push(b);
    used += cost;
  }

  return { included, omittedIds };
}
