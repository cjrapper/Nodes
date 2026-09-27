/**
 * L0 身份内核的契约测试。
 *
 * ## 为什么单独测这个
 *
 * L0 是每一轮 prompt 的**第一层**，它的措辞直接决定模型怎么干活。
 * 而它是靠字符串拼接生成的 —— 拼接逻辑里的问题（重复、冲突、自相矛盾）
 * 类型检查和普通单测都看不见，只有把渲染结果拿出来逐条断言才能守住。
 *
 * ## 这里守的是两个真实缺陷
 *
 * ### 1. 模板句会稀释用户的人设
 *
 * 原先无论用户填什么，开头都固定拼「你是「XX」这个知识库的写作与分析助手」。
 * 用户填「游戏开发面试陪练」时，这两句直接打架 —— 而且模板句更靠前、
 * 更像系统指令，模型倾向于服从它，用户精心写的定位就被稀释了。
 *
 * ### 2. 输出契约曾经**否决了本工具最主要的用法**
 *
 * 原契约：「只依据提供的知识块内容作答；知识块里没有的信息，明确说明
 * "知识块中未涵盖"，不要编造。」
 *
 * 而用户点「AI 分析」要的正是"这个模块还缺什么"—— **"缺什么"必然在
 * 知识块之外**。按原契约，模型只能回答"知识块中未涵盖"，
 * 于是「查漏补缺」从设计上被自己的提示词否决了。
 *
 * 正确的划界是**区分事实与判断**：判断该给，事实不许编。
 * 下面的断言就是钉住这条界线。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderPersona } from "../src/lib/cache/layers.ts";
import { DEFAULT_PERSONA } from "../src/lib/db/defaults.ts";

/** 契约段的文本（`# 输出契约` 之后的部分） */
function contractOf(rendered: string): string {
  const at = rendered.indexOf("# 输出契约");
  assert.notEqual(at, -1, "L0 必须带输出契约段 —— 否则来源标注、反编造这些底线全丢了");
  return rendered.slice(at);
}

/** 身份段的文本（`# 你的身份` 到 `# 输出契约` 之间） */
function identityOf(rendered: string): string {
  const start = rendered.indexOf("# 你的身份");
  const end = rendered.indexOf("# 输出契约");
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return rendered.slice(start, end);
}

/* ------------------------------------------------------------------ *
 * 1. 人设不被模板句稀释
 * ------------------------------------------------------------------ */

test("有自定义人设时，不追加任何写死的角色说明", () => {
  const rendered = renderPersona("你是一位资深游戏开发工程师，做我的面试陪练。", "我的知识库");
  const identity = identityOf(rendered);

  assert.ok(identity.includes("面试陪练"), "用户的人设必须原样出现");
  assert.doesNotMatch(
    identity,
    /写作与分析助手/,
    "不能追加与用户人设冲突的角色说明 —— 那会稀释用户的定位",
  );
});

test("有自定义人设时，不再塞一句「你服务于 XX 知识库」", () => {
  /*
   * 这句看起来无害，实际两头不讨好：
   *  - 用户自己写「知识库助手」时它是重复的；
   *  - 用户写「面试陪练」时它和角色冲突。
   * 工作区名对人设没有信息量，省掉。
   */
  const rendered = renderPersona("你是一位面试陪练。", "我的知识库");
  assert.doesNotMatch(identityOf(rendered), /服务于/, "不该有这类冗余的角色声明");
});

test("人设为空白时给出兜底角色，L0 不能整个消失", () => {
  // 人设为空时旧实现直接 return "" —— 那样 L0 层会变成空字符串，
  // 输出契约（来源标注、反编造）也跟着一起没了
  for (const empty of ["", "   ", "\n\n"]) {
    const rendered = renderPersona(empty, "我的知识库");
    assert.ok(rendered.length > 0, `人设为空时 L0 不应为空白（输入 ${JSON.stringify(empty)}）`);
    assert.ok(rendered.includes("我的知识库"), "兜底角色说明里要点出工作区名");
    assert.ok(rendered.includes("# 输出契约"), "输出契约必须始终存在");
  }
});

/* ------------------------------------------------------------------ *
 * 2. 输出契约不能否决「查漏补缺」
 * ------------------------------------------------------------------ */

test("契约不得禁止模型使用知识块之外的信息（那会让「AI 分析」失效）", () => {
  const contract = contractOf(renderPersona(DEFAULT_PERSONA, "我的知识库"));

  /*
   * 这条是本次修复的核心。
   * 「这个模块还缺什么」的答案**必然在知识块之外** ——
   * 任何"只依据提供的知识块作答"的要求都会让这个功能无法工作。
   */
  assert.doesNotMatch(
    contract,
    /只依据提供的知识块/,
    "不能要求模型只依据知识块作答 —— 「指出缺口」需要的正是知识块之外的信息",
  );
  assert.doesNotMatch(
    contract,
    /知识块中未涵盖/,
    "不能要求模型用「知识块中未涵盖」来回避 —— 那等于否决查漏补缺",
  );
});

test("契约明确授权模型给专业判断，并覆盖缺失主题这类场景", () => {
  const contract = contractOf(renderPersona(DEFAULT_PERSONA, "我的知识库"));
  assert.match(contract, /专业判断/, "必须显式授权判断");
  assert.match(contract, /不受/, "必须写明不受「只依据知识块」的限制");
  assert.match(contract, /缺失/, "要点出「缺失的主题」这类具体场景");
});

test("契约保留了「不许编造事实」这条底线，且只针对事实", () => {
  const contract = contractOf(renderPersona(DEFAULT_PERSONA, "我的知识库"));
  assert.match(contract, /不要编造具体事实/, "反编造这条底线不能因为放宽判断而丢掉");
  assert.match(contract, /不确定/, "要给出「不确定就说不确定」这条出路");
  // 关键：反编造必须限定在**事实**上。不加限定的话，模型会连判断一起不敢给，
  // 又回到"什么都不说"的状态。
  assert.match(contract, /API 签名|版本行为|性能数字/, "要举出具体的事实类别作为边界");
});

test("契约要求区分「笔记原文」与「模型判断」", () => {
  const contract = contractOf(renderPersona(DEFAULT_PERSONA, "我的知识库"));
  assert.match(contract, /分清/, "必须要求区分来源 —— 否则用户无法核对哪句是自己的笔记");
});

test("契约保留来源标注格式与语言要求", () => {
  const contract = contractOf(renderPersona(DEFAULT_PERSONA, "我的知识库"));
  assert.match(contract, /文档名 › 小节/, "来源标注格式不能丢");
  assert.match(contract, /简体中文/, "语言要求不能丢");
});

/* ------------------------------------------------------------------ *
 * 3. 缓存相关：L0 必须是确定性的
 * ------------------------------------------------------------------ */

test("同一输入渲染两次逐字节相同（L0 是缓存前缀，不能有随机性）", () => {
  const a = renderPersona(DEFAULT_PERSONA, "我的知识库");
  const b = renderPersona(DEFAULT_PERSONA, "我的知识库");
  assert.equal(a, b, "L0 有任何抖动都会让全部会话的缓存前缀失效");
});

test("人设首尾空白不影响结果（避免存库时的空格造成假失效）", () => {
  const clean = renderPersona("你是一位面试陪练。", "我的知识库");
  const padded = renderPersona("\n\n  你是一位面试陪练。  \n\n", "我的知识库");
  assert.equal(padded, clean, "首尾空白不该改变 L0 —— 否则用户手滑加个换行就白烧一次缓存");
});

test("默认人设本身包含职责与回答要求，不是空壳", () => {
  // 默认人设是用户开箱即得的东西，必须有实质内容
  assert.ok(DEFAULT_PERSONA.length > 300, `默认人设太短（${DEFAULT_PERSONA.length} 字符），大概是没写完`);
  // 三件正事：当面试官 / 补盲区 / 逼我讲原理
  for (const must of ["面试", "盲区", "原理"]) {
    assert.ok(DEFAULT_PERSONA.includes(must), `默认人设应当包含「${must}」`);
  }
  assert.match(DEFAULT_PERSONA, /三件正事|职责/, "要有明确的职责段落");
});

/* ------------------------------------------------------------------ *
 * 4. 多角度分析 —— 用户最核心的诉求
 *
 * 用户的处境是：找不到有经验的行业前辈，只能靠 AI；而且他明确意识到
 * 「我自己的思维局限会反过来局限 AI」—— 他问不出自己想不到的问题。
 *
 * 所以人设必须**反过来主导分析框架**，而不是被动应答。这一节钉住的是：
 * 那些"补盲区"的要求不能被后续修改顺手删掉。
 * ------------------------------------------------------------------ */

test("人设要求跳出用户给的框架，并主动指出没想到的角度", () => {
  assert.match(DEFAULT_PERSONA, /盲区/, "必须点明「补盲区」是它的正事");
  assert.match(
    DEFAULT_PERSONA,
    /我没问|没想到|想不到/,
    "必须要求它主动指出用户没问但该知道的 —— 这是对「思维局限反过来局限 AI」的正面回应",
  );
});

test("人设要求的多视角里必须包含商业与市场", () => {
  // 用户明确点名要商业/市场等多角度。技术只是一个维度，
  // 而商业与市场恰恰是没有行业经验的人最难自己补上的部分。
  for (const angle of ["技术", "场景", "商业", "市场", "玩家体验"]) {
    assert.ok(DEFAULT_PERSONA.includes(angle), `人设缺少分析角度：${angle}`);
  }
});

test("人设要求场景先行，并禁止用「视情况而定」敷衍", () => {
  assert.match(DEFAULT_PERSONA, /场景先行|适用场景/, "必须要求先摆场景再下结论");
  assert.match(
    DEFAULT_PERSONA,
    /视情况而定/,
    "必须点名禁止「视情况而定」式敷衍 —— 那等于把判断推回给用户",
  );
  // 禁止之后必须给出正确做法，否则模型只会换个说法继续敷衍
  assert.match(DEFAULT_PERSONA, /每种场景里给出明确答案|明确答案/, "要给出替代做法");
});

test("人设要求纠正提问里的错误前提", () => {
  assert.match(
    DEFAULT_PERSONA,
    /前提.*错|先纠正前提/,
    "用户问了一个前提就错的问题时必须先纠正 —— 否则只是在错误框架里陪他绕",
  );
});

/* ------------------------------------------------------------------ *
 * 5. 「不死板」与「认真负责」两条必须同时成立
 * ------------------------------------------------------------------ */

test("人设允许它有观点、不像手册，但不许软化判断", () => {
  // 「不死板」：允许观点、允许承认判断不了、不客套
  assert.match(DEFAULT_PERSONA, /该有观点就有观点|有观点/, "要允许它表达观点，而不是罗列可能性");
  assert.match(DEFAULT_PERSONA, /不要客套|不要「这是个很好的问题」/, "要禁止客套开场");

  // 「认真负责」：不许为了让人舒服而软化
  assert.match(
    DEFAULT_PERSONA,
    /不要为了让我舒服而软化判断/,
    "不许软化判断 —— 这是「认真负责」的核心，不能被当成不礼貌删掉",
  );
});

test("人设声明了诚实边界，且说明编造的具体危害", () => {
  assert.match(DEFAULT_PERSONA, /不许编造具体事实/, "反编造底线必须保留");
  assert.match(
    DEFAULT_PERSONA,
    /背下来/,
    "要说明编造的具体危害（用户会背下来并在面试被拆穿），而不只是「不要编造」",
  );
  assert.match(DEFAULT_PERSONA, /判断不了|不知道/, "要允许它说「我判断不了」");
});

test("人设承认用户找不到行业前辈这个上下文", () => {
  // 动机写在人设里，模型才知道该往哪个方向补位
  assert.match(DEFAULT_PERSONA, /资深从业者|行业前辈|只能靠你/, "人设里要有用户处境的说明");
});
