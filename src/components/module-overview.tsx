"use client";

/**
 * 模块概览页 —— 「这个方向我整理了多少」+「还缺什么、哪里写得不对」。
 *
 * 产品前提（决定了这个页面为什么长这样）：
 *
 *   - **模块不是文档**。它是一个纯分类容器，自己不写正文，只把同类知识点挂在一起
 *     （「Unity」「图形学」「C++ 基础」）。所以页面里没有任何编辑器、没有正文渲染，
 *     只有「这个方向下挂了多少东西」和「这些东西被 AI 看过多少」。
 *
 *   - **用户的目标是学习 + 找工作**，不是归档。归档只关心「东西在不在」，
 *     求职关心「够不够、对不对」。所以概览卡只回答覆盖度，剩下的都交给 AI 行动。
 *
 * 三个关键决策写在下面，都有代价，改之前先看完：
 *
 *  1. **覆盖度 = 已引用块 / 总块数**，不是「文档数 / 目标文档数」。理由见 COVERAGE_NOTE。
 *  2. **AI 行动做成三个固定预设，不做自由输入框**。理由见 MODULE_AI_ACTIONS。
 *  3. **本组件零 hooks、零 useState、零 useEffect**，纯由 props 决定渲染。
 *     `Date.now()` 直接在渲染里调用（只在 formatRelative 内部），刻意不为它加
 *     state 或 interval：一个定时器驱动的重渲染会让整棵子树每秒重建一次，
 *     而相对时间的分钟级精度并不值得。副作用是**渲染是纯函数**，不存在
 *     内联回调进 effect 依赖 → 渲染循环的可能（DESIGN.md 5.1 记载过这类真实事故）。
 */

import { ClipboardCheck, HelpCircle, Layers, Plus, SearchCheck, Target } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/* ------------------------------------------------------------------ *
 * 契约
 * ------------------------------------------------------------------ */

export interface ModuleChildDoc {
  id: string;
  title: string;
  /** 该文档的知识块数量 */
  blockCount: number;
  /** 已经挂载进某个对话过的块数（>0 说明这个知识点被 AI 看过） */
  referencedBlockCount: number;
  updatedAt: number;
}

export interface ModuleOverviewProps {
  /** 模块自身的 id 与标题 */
  moduleId: string;
  moduleTitle: string;
  /** 模块下的文档（不含更深层的子模块） */
  docs: ModuleChildDoc[];
  /** 更深层的子模块数量（仅用于提示，可为 0） */
  subModuleCount?: number;
  /** 点某篇文档 → 打开它 */
  onOpenDoc: (docId: string) => void;
  /** 在这个模块下新建一篇文档 */
  onCreateDoc: () => void;
  /** 触发 AI 分析。kind 见下。 */
  onRunAiAction: (action: ModuleAiAction, prompt: string) => void;
  className?: string;
}

export type ModuleAiAction = "gap" | "prep" | "quiz";

/* ------------------------------------------------------------------ *
 * 本地工具（刻意不引 @/lib/ui/client）
 * ------------------------------------------------------------------ */

/**
 * 类名拼接。
 *
 * 刻意在本文件内实现，而不是 import `@/lib/ui/client` 的 `cn`：那个模块正被
 * 并行改动，模块概览页不该因为它的签名变动而编译不过（`cache-dashboard.tsx`
 * 出于同样的理由也自带了一份格式化函数）。
 */
function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * Unix 毫秒 → 相对时间。
 *
 * 分档：刚刚（<1 分钟）/ N 分钟前 / N 小时前 / N 天前（<30 天）/ 绝对日期。
 *
 * 两个兜底必须留着：
 *  - **未来时间戳 → 「刚刚」**。客户端与服务端的时钟不同步、或数据被手工改过时，
 *    差值为负会算出「-3 分钟前」这种读起来像 bug 的东西，不如统一归到「刚刚」。
 *  - **非法 / 缺失 → 「—」**，绝不让 NaN 或者 "Invalid Date" 漏到界面上。
 */
function formatRelative(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";

  const diff = Date.now() - ms;
  if (diff < 0) return "刚刚"; // 时钟漂移或未来时间戳
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;

  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return `${days} 天前`;

  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/** 负数 / NaN 一律按 0 处理：脏数据不该让计数与覆盖度出现负值或 NaN% */
function safeCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/* ------------------------------------------------------------------ *
 * 文案
 * ------------------------------------------------------------------ */

/**
 * 模块底部说明。
 *
 * 不是客套话：用户点进模块页会下意识找"正文在哪、为什么不能打字"，
 * 必须有一句话把「模块 = 分类容器」这件事讲明白，否则会被当成缺功能。
 */
const MODULE_FOOTER_NOTE =
  "模块本身不写正文，只用来把同一类知识点归档在一起。点任意一篇知识点打开它，或在上方新建一篇。";

/** 没有任何文档时的引导 */
const EMPTY_HINT =
  "这个模块还是空的。知识点是你要复习和面试的最小单位，先建一篇，把已经会的东西写下来 —— 有内容之后 AI 才能帮你查漏补缺。";

/**
 * 覆盖度条为 0 时的引导。
 *
 * 为什么单独写一句而不是复用「0%」：0% 有两种完全不同的成因 ——
 * 「一篇都没写」（该先去写）和「写了很多但一次都没交给 AI」（该去点按钮）。
 * 只显示 0% 会让后者以为自己在偷懒，实际上他只是没用过这个功能。
 */
const COVERAGE_EMPTY_HINT = "还没有把内容交给 AI 看过。用下面的按钮让它帮你查漏补缺。";

/** 覆盖度条本身是什么的口径说明 —— 百分比必须解释清楚它到底在数什么 */
const COVERAGE_NOTE =
  "覆盖度 = 已被 AI 引用过的知识块 ÷ 总知识块。它衡量的是「有多少内容真的进过 AI 的上下文」——只有被 AI 看过的内容才可能被指出错误、被拿去出题，写下来但从未引用过的内容等于还没被检验。";

/**
 * 列表自身滚动的阈值。
 *
 * 超过这个数量就把列表区限制高度并允许内部滚动，而不是让页面无限变长：
 * 概览页的价值在顶部（覆盖度 + AI 行动），列表只是索引，不该把它顶出屏幕。
 */
const SCROLL_THRESHOLD = 15;

/* ------------------------------------------------------------------ *
 * AI 行动预设
 * ------------------------------------------------------------------ */

/**
 * 图标映射。
 *
 * 抽成 Record 而不是在数组里塞组件，是为了让 `icon` 字段保持可序列化的字符串 ——
 * 调用方拿到 MODULE_AI_ACTIONS 后可以把它塞进 state、存进配置、或者渲染在别处，
 * 不必搬运 React 组件引用。
 */
const ICONS: Record<"search" | "check" | "prep" | "quiz", LucideIcon> = {
  search: SearchCheck,
  // 「评判修改」已并入「AI 分析」，把这个映射留着是因为 icon 字段是可序列化的
  // 字符串，调用方（或将来新增的任务）仍可能用到它
  check: ClipboardCheck,
  prep: Target,
  quiz: HelpCircle,
};

/**
 * 两个预设 AI 任务。
 *
 * **为什么是固定预设，而不是一个自由输入框？**
 *
 *  1. **用户不知道该问什么，正是他打开这个页面的原因。** 他缺的是「我该检查
 *     什么」这个判断，把判断推回给他（给一个空白输入框）等于把问题原样退回。
 *  2. **这些动作覆盖了复习闭环**：现有内容对不对 → 还缺什么 → 记住了没。
 *     自由输入框能表达这三件事，但**不会提醒用户还有另外两件**，
 *     于是最常见的用法会退化成"随便问问"，价值归零。
 *  3. **prompt 是本产品的核心资产，不该让用户每次重写。** 这里的每条 prompt
 *     都带了角色（游戏开发求职视角）、约束（只依据挂载内容）、
 *     以及输出格式要求（排序 / 逐条 / 给答案要点），这些约束是产品方反复
 *     调过的，用户自己临时写的多半是一句「帮我看看」。
 *
 * 代价是表达力受限：用户想问的东西如果不在预设里，只能去对话面板自由提问。
 * 这是刻意的取舍 —— 概览页负责"把标准动作做对"，对话面板负责"什么都能问"。
 *
 * ## 为什么从三个减到两个
 *
 * 最初是「查漏补缺 / 评判修改 / 自测提问」。用户反馈前两个其实是同一件事的
 * 两面：判断"缺什么"必须先把现有内容看一遍，而看一遍的结果自然包括
 * "哪些写错了、哪些太薄"。拆成两个按钮等于把同一次分析花两次钱做，
 * 而且第二遍是在第一遍之后看的，两边结论还可能互相打架。
 *
 * 现在合成一个「AI 分析」，**内部按固定顺序输出**：先判现有内容站不站得住，
 * 再谈缺什么。顺序是有意的 —— 反过来的话，会在错误的、过时的内容上继续加东西。
 *
 * 「自测提问」保持独立：它是**输出**任务（出题、给答案），
 * 与"审视输入"是两种不同的用法。
 *
 * 每条 prompt 都显式要求「不要把我没写过的东西说成写过了」，因为模型在缺少
 * 约束时会顺着领域常识自由发挥，编出一堆用户根本没写过的"知识点"，
 * 让他误以为自己整理过。
 *
 * ⚠️ 但这个约束的**作用域必须限定在"我写了什么"上，不能扩到"能分析什么"**。
 * 早先的写法是「只依据我实际挂载的内容判断」，那是一句过宽的约束：
 * 它把"判断我的笔记"和"判断这个领域"混为一谈，于是
 * 「缺什么主题」「市场怎么看」「换个场景还成不成立」这类问题
 * **全部被自己的提示词禁掉了** —— 而这些恰恰是用户最需要 AI 补的部分
 * （他没有行业经验，问不出自己想不到的角度）。
 *
 * 正确的划界：**事实归属要严格，分析维度要开放**。见下面每条 prompt 里的写法。
 */
export const MODULE_AI_ACTIONS: {
  kind: ModuleAiAction;
  label: string;
  hint: string;
  prompt: string;
  icon: "search" | "check" | "prep" | "quiz";
}[] = [
  {
    kind: "gap",
    label: "AI 分析",
    hint: "以秋招面试官视角评估这一块",
    icon: "search",
    prompt: [
      "我挂载了一个学习模块的全部知识点。**我正在秋招**，请以面试官视角",
      "帮我判断：这块内容现在能支撑我到什么程度，以及接下来该把时间花在哪。",
      "",
      "关于「依据什么」的边界（重要）：",
      "1. 判断**我写了什么**时只依据挂载内容：不要说我写过任何没有出现在",
      "   上下文里的主题。如果你认为某个主题「已经有了」，必须说得出它对应哪一篇；",
      "   说不出就不要提。",
      "2. 但判断**这个方向该有什么、行业里怎么考**时，请充分用你的行业经验与",
      "   面试经验 —— 这正是我找你而不是自己看的原因。缺口的答案本来就在我的",
      "   笔记之外。",
      "3. 两条混在一起时，明确分开：哪些是我笔记里的、哪些是你的判断。",
      "4. 每条问题都必须指向具体位置（哪一篇、哪一段），并给出可以直接照着改的建议。",
      "5. 不要说「建议补充更多细节」这类空话 —— 要具体说明补什么、怎么补。",
      "6. 宁可少列几条也不要凑数：每一条都要能解释清楚为什么它是问题或缺口。",
      "7. **每条建议都要带时间账**：大概要花多少时间、以及它挤掉了什么。",
      "   我时间有限，没有时间账的建议等于帮倒忙。",
      "",
      "请按下面四部分输出。**顺序很重要**：先判断已有内容是否站得住，",
      "再谈其他的 —— 否则我会在错误的、含糊的、过时的内容上继续堆东西。",
      "",
      "一、现有内容的问题",
      "   1. 正确性（最高优先级）：技术错误、说反了的因果关系、过时的信息",
      "      （例如已被废弃的 API、已变更的渲染管线 / 引擎行为）、术语误用。",
      "      每条注明：错在哪、正确的说法是什么、为什么容易记错。",
      "      **如果我说错了而我自己不知道，请重点标出来** —— 那是最危险的一类，",
      "      因为我会在面试里自信地说错。",
      "   2. 表述含糊：指出「大概」「一般来说」「性能更好」这类无法验证的说法，",
      "      改写成一个有明确条件的句子。这类表述在面试里会被连续追问到塌。",
      "   3. 撑不住追问的地方：哪些内容只有骨架，缺的是哪一层",
      "      （概念定义 / 实现原理 / 项目中的应用 / 踩过的坑）。",
      "      并告诉我：**按现在的深度，面试官追问到第几层我就会答不上来。**",
      "",
      "二、面试官会怎么考这一块",
      "   （这一节不是「还缺哪些知识点」，而是「这些内容会被怎么考」。）",
      "   - 挑出这块内容里**最可能被问到**的 3~5 个点，按出现频率排序。",
      "   - 每个点给：真实问法（面试官的原话）、答到什么程度算过关、",
      "     常见的追问方向、以及**一听就是背的**的回答是什么样。",
      "   - 指出哪些内容适合作为**主动展示的加分项**（面试里我可以自己往这上面引），",
      "     哪些是**不要主动提**的（提了会引出我答不好的追问）。",
      "",
      "三、我没想到要问的（这一节请认真写）",
      "   - 我是在企业软件方向工作、想转游戏行业的，**视野窄是我最大的风险**。",
      "     所以这一节请指出：一个合格的候选人应该关心、但我笔记里完全没有体现",
      "     的**思考维度**，而不只是知识点。",
      "   - 至少覆盖：什么场景下这些知识才成立（手游 / 主机 / PC、独立 / 3A、",
      "     单机 / 联网）；同一个技术选择在商业与市场层面是怎么被决定的；",
      "     玩家能不能感知到、工程上值不值得做。",
      "   - 还要覆盖一层：**招人方为什么招这个岗位**（新项目立项、老项目救火、",
      "     出海、技术栈迁移…），这决定了他想听什么。",
      "   - 每条说明：为什么这个维度重要、我大概率会怎么想错、面试里会怎么被考到。",
      "",
      "四、秋招期的时间分配（请给明确取舍，不要给清单）",
      "   - 结合上面几部分，给出**最该做的前三件事**，并明确说出**该放掉什么**。",
      "   - 每件事写清：现在的状态 → 目标状态 → 大约需要多少时间 →",
      "     为什么它排在这个位置（而不是别的）。",
      "   - 判断原则：**在秋招期，「把已有的东西练到能讲清」的边际收益",
      "     通常高于「开一个新主题」**。如果我的缺口里有明显违背这条的，请说明理由。",
      "   - 如果我的内容其实已经够用了，**请直接说「这块可以了，别再投入」** ——",
      "     我需要知道什么时候可以停，否则我会一直在这里打磨。",
    ].join("\n"),
  },
  {
    kind: "prep",
    label: "岗前准备",
    hint: "粘一份 JD，我告诉你该怎么准备",
    icon: "prep",
    prompt: [
      "我正在秋招，马上要面一个岗位。下面是我的**目标岗位 JD**，",
      "以及我挂载的、自己为这个方向整理的知识点。",
      "",
      "【在这里粘贴岗位 JD】",
      "",
      "请以「带过团队、也当过面试官的游戏行业工程师」的身份，帮我做一次针对性准备。",
      "",
      "关于依据的边界：",
      "1. 判断**我写了什么**时只看挂载内容，不要说我写过我没写过的东西。",
      "2. 判断**这个岗位要什么、会怎么考我**时，充分用你的行业经验 ——",
      "   这正是我找你而不是自己看 JD 的原因。JD 上写的和实际面的是两回事，",
      "   请把这两者的差别说出来。",
      "3. 如果我没有粘 JD（上面那行还是占位符），**先问我 JD 内容再分析**，",
      "   不要凭空猜岗位要求。",
      "",
      "请按下面四部分输出。",
      "",
      "一、这个岗位到底在找什么人",
      "   - 从 JD 的字面读出：职级、方向（客户端 / 引擎 / 图形 / 工具…）、",
      "     项目阶段（新立项 / 在研 / 上线运营）、技术栈，以及**它没写但你能推断的**。",
      "   - 判断**招人方为什么招这个岗位**：新项目立项、老项目救火、技术栈迁移、",
      "     出海适配…… 这决定了面试官想听什么。",
      "   - 我从企业软件转过来，**这个岗位对我这类背景的候选人是友好还是苛刻？**",
      "     如果是苛刻的，直说 —— 我可以把时间投到别的岗位上。",
      "",
      "二、我的内容与这个岗位的匹配度",
      "   - 哪几块是我**可以直接讲**的（有内容、讲得出原理）→ 这些要主动往上面引。",
      "   - 哪几块是**半成品**（有内容但撑不住追问）→ 标出追问到第几层会塌，",
      "     以及**面试前最值得补的那一两处**。",
      "   - 哪几块是岗位明确要、但我**完全没写**的 → 按「这场面试前必修 / 可以坦白说不会 /",
      "     其实用不上」三档分开。**不要把它们混成一个待办清单。**",
      "",
      "三、这场面试的准备清单（要能今天就开始做）",
      "   - 按投入产出排序，给出**前三条**，每条写清：做什么、大概几小时、",
      "     做完之后我在面试里的表现会有什么具体变化。",
      "   - 明确说出**该放弃什么** —— 时间只够做几件事，我需要知道哪些不做也没关系。",
      "   - 单独给一节：**我的项目经历该怎么讲**。从企业软件转游戏，",
      "     我的项目多半不是游戏项目，请告诉我怎么把它讲成对游戏岗有价值的样子，",
      "     以及**不要硬吹**的边界在哪里（吹了会被追问到塌）。",
      "",
      "四、我该反问什么",
      "   - 给 3~5 个**只有懂行的人才会问**的问题，覆盖：团队在做什么、",
      "     技术栈与工程现状、我进去会负责哪一块、团队怎么看技术债。",
      "   - 说明每个问题**面试官会怎么理解**（问了显得你懂行，还是显得你在挑活），",
      "     以及**不该问什么**（哪些问题在这个阶段会被扣分）。",
      "",
      "最后单独一段：**这场面试我最可能挂在哪里。**",
      "直说，不要照顾我的情绪。我宁可现在难受，也不想面完才知道。",
    ].join("\n"),
  },
  {
    kind: "quiz",
    label: "自测提问",
    hint: "根据内容出面试题",
    icon: "quiz",
    prompt: [
      "现在对我挂载的内容做一次模拟面试。请基于这些内容出 5~8 道题。",
      "",
      "严格约束：",
      "1. **出题范围**只限于我挂载的内容，不要考我没写过的领域 —— 那测不出我的",
      "   准备程度。（注意这只约束「考什么」。参考答案、追问方向、真实项目里的",
      "   判断标准，都请充分用你的行业经验，不要被我的笔记限制住。）",
      "2. 不要出能靠背诵回答的问题。「请解释什么是 X」这类题一律不要。",
      "   要出追问式的题：给一个具体场景或反例，问我为什么、如果改成另一种情况会怎样、",
      "   边界条件在哪里。",
      "3. 至少要有一道题把技术选择放进**真实项目约束**里（成本、周期、团队规模、",
      "   发行平台、目标用户），因为这类问题我完全没有经验，也最容易答成技术报告。",
      "4. 难度从基础到深入递进，后面几道应该需要把多个知识点连起来才能答好。",
      "",
      "每道题请给出：",
      "   - 题干（模拟面试官的真实问法，可以带一点压迫感）",
      "   - 参考答案要点（分点，写清楚哪些点是必须答到的）",
      "   - 这道题在考什么（考察意图）",
      "   - 我挂载的内容里对应哪一块，以及按现有内容能答到什么程度",
      "",
      "最后请单独列一节「暴露理解漏洞的题」：",
      "指出哪几道题最可能把我问住、为什么它们容易暴露问题",
      "（例如概念记住了但推不出结论、只知结论不知取舍），",
      "并告诉我应该回头补哪一块。",
    ].join("\n"),
  },
];

/* ------------------------------------------------------------------ *
 * 组件
 * ------------------------------------------------------------------ */

export default function ModuleOverview({
  moduleId,
  moduleTitle,
  docs,
  subModuleCount = 0,
  onOpenDoc,
  onCreateDoc,
  onRunAiAction,
  className,
}: ModuleOverviewProps): React.JSX.Element {
  /*
   * 全部统计都在渲染期直接算，不用 useMemo。
   *
   * 这里没有 hooks 是有意的：统计是 O(n) 的整数加法，n 是模块下的文档数
   * （几十到几百），重算的开销远小于维护一层缓存的复杂度；而这个组件本身
   * 没有内部状态，父组件不重渲染它就不会重渲染。
   * 反过来，一旦引入 useMemo / useState，就得处理依赖数组 —— 而依赖数组正是
   * DESIGN.md 5.1 那次"文档列表疯狂闪烁"事故的源头。
   */
  const docCount = docs.length;

  // 总计用 safeCount 兜底：上游若给了负数或 NaN，界面上不该出现负的块数
  let totalBlocks = 0;
  let referencedBlocks = 0;
  for (const doc of docs) {
    const total = safeCount(doc.blockCount);
    // 已引用块数按「总块数」封顶：同一块被引用两次或上游统计串了，都不该
    // 让覆盖度超过 100%（100% 以上的进度条会让人以为整个页面坏了）
    referencedBlocks += Math.min(safeCount(doc.referencedBlockCount), total);
    totalBlocks += total;
  }
  if (referencedBlocks > totalBlocks) referencedBlocks = totalBlocks;

  /** 0~1。总块数为 0 时定义为 0（不是 NaN）—— 分母为 0 是"没有内容"，不是"全覆盖" */
  const coverage = totalBlocks > 0 ? referencedBlocks / totalBlocks : 0;
  const coveragePercent = Math.round(coverage * 100);
  const hasContent = totalBlocks > 0 && docCount > 0;

  /*
   * 按更新时间倒序。
   *
   * 先复制再排序：`[...docs].sort()` 不能写成 `docs.sort()` —— 后者会就地改写
   * 父组件传进来的数组（React 的 props 是只读的，改它会引发父组件状态与
   * 渲染结果不一致的诡异 bug）。
   *
   * 并列时用 id 做稳定兜底：同一秒更新的两篇文档若顺序不确定，
   * 每次渲染都可能互换位置，看起来像列表在抖。
   */
  const sortedDocs = [...docs].sort((a, b) => {
    const diff = (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const hasMany = sortedDocs.length > SCROLL_THRESHOLD;

  return (
    <section
      // 用 moduleId 拼 id：同页可能出现多个模块面板，id 必须唯一
      aria-labelledby={`module-overview-title-${moduleId}`}
      className={cn(
        "flex h-full min-h-0 flex-col gap-3 rounded-xl border border-[#23282f] bg-[#0b0d10] p-3",
        className,
      )}
    >
      {/* ---------------- 顶部概览卡 ---------------- */}
      <div className="rounded-xl border border-[#23282f] bg-[#12151a] p-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2
            id={`module-overview-title-${moduleId}`}
            className="min-w-0 truncate text-[15px] font-medium text-[var(--nodes-ink)]"
          >
            {moduleTitle}
          </h2>
          {/* 子模块数只在真的存在时才提，避免每页都出现一个「0 个子模块」 */}
          {subModuleCount > 0 && (
            <span className="shrink-0 text-[11px] text-[var(--nodes-ink-faint)]">
              {`另有 ${subModuleCount} 个子模块`}
            </span>
          )}
        </div>

        {/* 三个数字：知识点数 / 总块数 / 已引用块数。用 description list 让屏幕阅读器也能配对 */}
        <dl className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <Stat label="知识点" value={docCount} accent="text-[var(--nodes-ink)]" />
          <Stat label="知识块" value={totalBlocks} accent="text-[#6aa8ff]" />
          <Stat label="已被 AI 引用" value={referencedBlocks} accent="text-[#3ddc97]" />
        </dl>

        {/* 覆盖度条 */}
        <div className="mt-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] text-[var(--nodes-ink-dim)]">覆盖度</span>
            <span className="font-mono text-[11px] text-[var(--nodes-ink-dim)]">
              {`${referencedBlocks} / ${totalBlocks} 块`}
            </span>
          </div>

          <div
            className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[#171b21]"
            role="progressbar"
            // 总块数为 0 时 max 也保持 0：此时 now=0、max=0 是自洽的"空"
            aria-valuemin={0}
            aria-valuemax={totalBlocks}
            aria-valuenow={referencedBlocks}
            // valuetext 覆盖默认朗读：把「x / y 块」和百分比一起说清楚
            aria-valuetext={
              hasContent
                ? `覆盖度 ${coveragePercent}%，${referencedBlocks} / ${totalBlocks} 个知识块已被 AI 引用`
                : "还没有内容可供 AI 评估"
            }
            aria-label="内容覆盖度"
          >
            <div
              className="h-full rounded-full bg-[#3ddc97] transition-[width] duration-300"
              // 宽度用内联 style：Tailwind 4 静态扫描类名，`w-[${n}%]` 这种运行时
              // 拼出来的类名永远不会被生成（同 outline-panel.tsx 的缩进处理）
              style={{ width: `${coveragePercent}%` }}
            />
          </div>

          {/* 0 覆盖度 → 引导语；有覆盖度 → 口径说明。都不为空，避免卡片高度跳变 */}
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--nodes-ink-faint)]">
            {coveragePercent === 0 ? COVERAGE_EMPTY_HINT : COVERAGE_NOTE}
          </p>
          {coveragePercent === 0 && (
            <p className="mt-1 text-[10px] leading-relaxed text-[var(--nodes-ink-faint)]/80">{COVERAGE_NOTE}</p>
          )}
        </div>
      </div>

      {/* ---------------- 三个 AI 行动 ---------------- */}
      <div>
        <div className="mb-1.5 flex items-center gap-1.5">
          <span className="text-[12px] font-medium text-[var(--nodes-ink)]">AI 分析</span>
          <span className="text-[11px] text-[var(--nodes-ink-faint)]">把整个模块交给 AI 过一遍</span>
        </div>

        {/* 窄屏竖排、宽屏横向三列：hint 是完整句子，挤成一行会全部截断 */}
        <ul role="list" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {MODULE_AI_ACTIONS.map((action) => {
            const Icon = ICONS[action.icon];
            const accent = ACTION_ACCENT[action.kind];
            return (
              <li key={action.kind}>
                <button
                  type="button"
                  onClick={() => onRunAiAction(action.kind, action.prompt)}
                  // aria-label 把 label 与 hint 合起来：屏幕上 hint 是视觉补充，
                  // 但屏幕阅读器用户只听到 label 会不知道这个按钮到底做什么
                  aria-label={`${action.label}：${action.hint}`}
                  className={cn(
                    "group flex h-full w-full flex-col gap-1 rounded-xl border border-[#23282f] bg-[#12151a] p-3 text-left transition-colors",
                    "hover:bg-[#171b21] focus-visible:ring-2 focus-visible:outline-none",
                    accent.ring,
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <Icon size={13} className={cn("shrink-0", accent.icon)} aria-hidden="true" />
                    <span className="text-[12px] font-medium text-[var(--nodes-ink)]">{action.label}</span>
                  </span>
                  <span className="text-[11px] leading-relaxed text-[var(--nodes-ink-dim)]">{action.hint}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* ---------------- 知识点列表 ---------------- */}
      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-[#23282f] bg-[#12151a]">
        <div className="flex items-center gap-1.5 border-b border-[#23282f] px-3 py-2">
          <Layers size={13} className="shrink-0 text-[#6aa8ff]" aria-hidden="true" />
          <span className="text-[12px] font-medium text-[var(--nodes-ink)]">知识点</span>
          <span className="ml-auto font-mono text-[10px] text-[var(--nodes-ink-faint)]">{`${docCount} 篇`}</span>
          <button
            type="button"
            onClick={onCreateDoc}
            aria-label="在这个模块下新建一篇知识点"
            className="flex shrink-0 items-center gap-1 rounded-md border border-[#23282f] px-1.5 py-0.5 text-[10px] text-[var(--nodes-ink-dim)] transition-colors hover:bg-[#171b21] hover:text-[var(--nodes-ink)] focus-visible:ring-2 focus-visible:ring-[#3ddc97] focus-visible:outline-none"
          >
            <Plus size={11} aria-hidden="true" />
            新建
          </button>
        </div>

        {docCount === 0 ? (
          /* 空态：先解释模块是什么，再给唯一的行动按钮 */
          <div className="flex flex-col items-start gap-2 px-3 py-4">
            <p className="max-w-[46ch] text-[11px] leading-relaxed text-[var(--nodes-ink-dim)]">{EMPTY_HINT}</p>
            <button
              type="button"
              onClick={onCreateDoc}
              aria-label="新建第一篇知识点"
              className="flex items-center gap-1.5 rounded-md border border-[#3ddc97]/40 bg-[#3ddc97]/10 px-2.5 py-1.5 text-[11px] font-medium text-[#3ddc97] transition-colors hover:bg-[#3ddc97]/15 focus-visible:ring-2 focus-visible:ring-[#3ddc97] focus-visible:outline-none"
            >
              <Plus size={12} aria-hidden="true" />
              新建第一篇知识点
            </button>
          </div>
        ) : (
          <div
            className={cn("min-h-0 overflow-y-auto px-2 py-1.5", hasMany && "max-h-[60vh]")}
            // 超过阈值才让列表自己滚（理由见 SCROLL_THRESHOLD）
          >
            <ul role="list" className="space-y-px">
              {sortedDocs.map((doc) => {
                const blocks = safeCount(doc.blockCount);
                const referenced = Math.min(safeCount(doc.referencedBlockCount), blocks);
                const relative = formatRelative(doc.updatedAt);
                return (
                  <li key={doc.id}>
                    <button
                      type="button"
                      onClick={() => onOpenDoc(doc.id)}
                      // 行内文字是分段的，屏幕阅读器逐个读会很碎；
                      // aria-label 给出一句完整的话，把标题、体量、更新时间一次说完
                      aria-label={`打开知识点「${doc.title}」，${blocks} 个知识块，其中 ${referenced} 个已被 AI 引用，更新于${relative}`}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[#171b21] focus-visible:ring-2 focus-visible:ring-[#3ddc97] focus-visible:outline-none"
                    >
                      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--nodes-ink)]">
                        {doc.title}
                      </span>

                      <span className="shrink-0 font-mono text-[10px] text-[var(--nodes-ink-faint)]">
                        {`${blocks} 块`}
                      </span>

                      {/* 已引用徽标：0 时不渲染 —— 一列「0」既占位置又传递不了信息 */}
                      {referenced > 0 && (
                        <span
                          className="shrink-0 rounded-full border border-[#3ddc97]/30 bg-[#3ddc97]/10 px-1.5 py-px font-mono text-[10px] text-[#3ddc97]"
                          title={`${referenced} 个块已被 AI 引用`}
                        >
                          {`AI ${referenced}`}
                        </span>
                      )}

                      <span className="w-[68px] shrink-0 text-right text-[10px] text-[var(--nodes-ink-faint)]">
                        {relative}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {/* ---------------- 底部说明 ---------------- */}
      <p className="shrink-0 px-1 text-[10px] leading-relaxed text-[var(--nodes-ink-faint)]">
        {MODULE_FOOTER_NOTE}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 内部小件
 * ------------------------------------------------------------------ */

/**
 * AI 行动的强调色。
 *
 * 区分颜色不是为了好看：按钮的文案都是「把模块交给 AI」，
 * 形状与措辞高度相似，唯一的视觉区分就是颜色。顺带把 focus ring 也绑到
 * 同一个色上，键盘操作时能立刻知道焦点落在哪个行动上。
 */
const ACTION_ACCENT: Record<ModuleAiAction, { icon: string; ring: string }> = {
  gap: { icon: "text-[#3ddc97]", ring: "focus-visible:ring-[#3ddc97]" },
  prep: { icon: "text-[#f5b544]", ring: "focus-visible:ring-[#f5b544]" },
  quiz: { icon: "text-[#a78bfa]", ring: "focus-visible:ring-[#a78bfa]" },
};

/** 概览卡里的一个计数。数值统一 font-mono，让三个数字的字符宽度一致、好横向扫视 */
function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: string;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-1.5">
      <dd className={cn("font-mono text-[16px] leading-none", accent)}>{value}</dd>
      <dt className="text-[11px] text-[var(--nodes-ink-faint)]">{label}</dt>
    </div>
  );
}
