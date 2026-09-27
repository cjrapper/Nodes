/**
 * 工具调用分片的累积器。
 *
 * 两个适配器把分片形态差异抹平后交给这里，**累积逻辑只此一份**。
 * 分成两份实现迟早会分叉，而分叉的后果是"参数拼错了但看起来正常" ——
 * 那种故障要等到工具报"缺少参数"才会浮出来，而那时已经离原因很远了。
 *
 * ## 这几条不变量都是踩出来的（不是设计出来的）
 *
 * 1. **按 `index` 归并，不能按数组下标。**
 *    同一个 chunk 里 `index:1` 可能排在 `index:0` 前面（并行工具调用时
 *    服务商不保证顺序）。按下标累积会把两个调用的参数串混在一起，
 *    拼出来是一段既不是 A 也不是 B 的 JSON。
 *
 * 2. **续片里的 `id` / `name` 是空串或 null 时，语义是"没变化"，绝不能覆盖。**
 *    部分兼容网关（以及某些 Ollama/vLLM 版本）每一片都重发这两个字段，
 *    值却是 `""` / `null`。无脑覆盖的后果是工具名变成空串 ——
 *    上层拿到 `name: ""`，报"未知工具"，而模型明明调的是 `search_blocks`。
 *    这个 bug 在 DeepSeek 的 issue 里出现过不止一次（#2090 / #3281 / #4370）。
 *
 * 3. **`arguments` 是字符串拼接，不是 JSON 合并，也不能中途 parse。**
 *    首片常常是空串；中间任意一片大几率不是合法 JSON（切在多字节字符中间
 *    或切在字符串字面量中间）。所以全程只做 `+=`，直到结束时才解析。
 *
 * 4. **执行时机是"流结束且 finish 原因表示要调工具"，不是"收到了分片"。**
 *    收到分片就执行的话，参数还是半截的。而且如果 `finish_reason` 是
 *    `length` / `aborted` / `insufficient_system_resource`，说明这一轮是被
 *    打断的 —— 参数可能残缺，此时**执行比不执行更糟**（会真的去改数据）。
 */

import type { ToolCall, ToolCallDelta } from "./types";

interface PartialCall {
  id: string;
  name: string;
  argsText: string;
}

export class ToolCallAccumulator {
  /**
   * ⚠️ `Map` 而不是数组：键是服务商给的 `index`，与到达顺序无关。
   */
  private readonly byIndex = new Map<number, PartialCall>();

  /** 记录一个分片。返回本次是否产生了新的调用（供 UI 显示"正在调用…"）。 */
  push(delta: ToolCallDelta): boolean {
    const existing = this.byIndex.get(delta.index);
    const call: PartialCall = existing ?? { id: "", name: "", argsText: "" };

    /*
     * 只接受**非空字符串**。空串/null 的语义是"这两片之间没有变化"，
     * 用它覆盖会把首片里真实的 id/name 抹掉。
     */
    if (typeof delta.id === "string" && delta.id !== "") call.id = delta.id;
    if (typeof delta.name === "string" && delta.name !== "") call.name = delta.name;
    if (typeof delta.argsDelta === "string" && delta.argsDelta !== "") {
      call.argsText += delta.argsDelta;
    }

    this.byIndex.set(delta.index, call);
    return existing === undefined;
  }

  /** 目前收到了几个调用（含尚未收完的） */
  get size(): number {
    return this.byIndex.size;
  }

  /**
   * 结束累积并产出可执行的调用列表，按 `index` 升序。
   *
   * 顺序很重要：回传工具结果时，`role:"tool"` 消息的顺序必须与 assistant
   * 那条 `tool_calls` 数组一致，否则服务商会报错或把结果对错调用。
   *
   * 没有 id 的调用会被**丢掉并回报**（返回值里的 `dropped`）——
   * 服务商要求 `tool_call_id` 必填，发一个空 id 回去是 400；
   * 而静默丢掉又会让"模型调了工具但没执行"变成一桩无头案。
   */
  finish(): { calls: ToolCall[]; dropped: number } {
    const sorted = [...this.byIndex.entries()].sort((a, b) => a[0] - b[0]);
    const calls: ToolCall[] = [];
    let dropped = 0;

    for (const [, call] of sorted) {
      if (call.name === "" || call.id === "") {
        dropped += 1;
        continue;
      }
      calls.push({
        id: call.id,
        name: call.name,
        /*
         * 空参数按 `{}` 兜底：模型请求一个无参数工具时，
         * 分片里可能一个 arguments 都没有（首片就是空串，之后没有续片）。
         * 直接留着空串的话，下游 JSON.parse("") 会抛 —— 而"没有参数"
         * 本来是完全合法的输入。
         */
        argsText: call.argsText.trim() === "" ? "{}" : call.argsText,
      });
    }

    return { calls, dropped };
  }

  reset(): void {
    this.byIndex.clear();
  }
}

/**
 * 解析工具参数，并给出**可读的失败原因**。
 *
 * 不能直接 `JSON.parse` 了事：模型确实会产出非法 JSON
 * （官方文档明确说"may hallucinate parameters"，要求调用方自行校验），
 * 而裸的 `SyntaxError: Unexpected token` 对用户毫无意义 ——
 * 他不知道是模型的问题、自己的问题，还是工具的问题。
 */
export function parseToolArgs(
  argsText: string,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const text = argsText.trim();
  if (text === "") return { ok: true, args: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        error: `工具参数必须是一个 JSON 对象，实际收到：${text.slice(0, 120)}`,
      };
    }
    return { ok: true, args: parsed as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      error:
        `工具参数不是合法 JSON（${err instanceof Error ? err.message : String(err)}）。` +
        `原始内容：${text.slice(0, 200)}`,
    };
  }
}
