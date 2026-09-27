/**
 * 轻量 token 估算器。
 *
 * 目标不是精确复刻某个 BPE，而是给出**单调且量级正确**的估算，
 * 用于：1) 组装阶段的成本/命中预测；2) 上下文超限的提前拦截。
 * 真实 token 数以服务商返回的 usage 为准，收到后会用真实值覆盖预测值。
 *
 * 校准依据（各家 tokenizer 的共同特征）：
 *  - CJK 表意文字在主流 BPE 里基本是 1 字 ≈ 0.6~1 token
 *  - 拉丁文本约 4 字符 ≈ 1 token（本项目取 1/3.6 略微保守）
 *  - 标点、空白、换行各自独立计权
 */

/** CJK 统一表意文字 + 兼容区 + 假名 + 谚文 */
const CJK_RE =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu;

/** 其余按拉丁/数字/符号处理的字符 */
const NON_CJK_CHUNK_RE = /[^\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/gu;

const CJK_TOKENS_PER_CHAR = 0.62;
const LATIN_CHARS_PER_TOKEN = 3.6;

/** 单条消息的角色开销（role 字段、分隔符等协议开销） */
export const MESSAGE_OVERHEAD_TOKENS = 4;

function countCjk(text: string): number {
  const matches = text.match(CJK_RE);
  return matches ? matches.length : 0;
}

function countNonCjk(text: string): number {
  const chunks = text.match(NON_CJK_CHUNK_RE);
  if (!chunks) return 0;
  let chars = 0;
  for (const chunk of chunks) chars += chunk.length;
  return chars;
}

/**
 * 估算一段文本的 token 数。纯函数、无状态，同一输入永远返回同一结果 ——
 * 这是缓存前缀可预测的前提。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = countCjk(text);
  const latin = countNonCjk(text);
  const newlines = (text.match(/\n/g) ?? []).length;
  const total =
    cjk * CJK_TOKENS_PER_CHAR +
    latin / LATIN_CHARS_PER_TOKEN +
    // 换行在多数 tokenizer 里不再单独计一个 token，但仍有权重
    newlines * 0.25;
  return Math.max(1, Math.ceil(total));
}

/** 估算一组字符串的总 token（含每条消息的协议开销） */
export function estimateMessagesTokens(parts: string[]): number {
  let sum = 0;
  for (const p of parts) sum += estimateTokens(p) + MESSAGE_OVERHEAD_TOKENS;
  return sum;
}

/**
 * 缓存对齐：服务商按固定块粒度（OpenAI 128 / DeepSeek 64）判定前缀是否复用，
 * 不足一块的尾部不会被缓存。这里把 token 数向下取整到块边界，
 * 用于给出**保守**的命中预测，避免仪表盘高估收益。
 */
export function alignToCacheBlock(tokens: number, blockSize: number): number {
  if (blockSize <= 1) return tokens;
  return Math.floor(tokens / blockSize) * blockSize;
}

/** 各服务商的判定粒度 */
export const CACHE_BLOCK_SIZE: Record<string, number> = {
  openai: 128,
  anthropic: 1, // 显式断点，按断点精确计费，无需对齐
  deepseek: 64,
  default: 64,
};

export function cacheBlockSizeFor(providerKind: string): number {
  return CACHE_BLOCK_SIZE[providerKind] ?? CACHE_BLOCK_SIZE.default;
}
