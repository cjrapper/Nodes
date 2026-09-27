/** SSE 流式读取的公共工具，供各适配器复用。 */

/** 负载解析结果：`data` = 有内容；`skip` = 空负载/注释之类，跳过；`done` = 结束标记 */
type SseOutcome = { kind: "data"; payload: string } | { kind: "skip" } | { kind: "done" };

/**
 * 解析一行 `data:`。
 *
 * ⚠️ 两端都要 trim，而且必须**先 trim 再判断 `[DONE]`**。
 *
 * 早先只 `trimStart()`，于是 `data: [DONE] `（结束标记后面跟一个空格，
 * 有些网关就是这么写的）不等于 `"[DONE]"`，结束标记被当成普通负载发出去。
 * 同时空负载 `data:` 会被当成一个空字符串事件 yield 出去 ——
 * 下游 `parseJsonSafe("")` 返回 null 侥幸没炸，但那是运气，不是设计。
 *
 * 更明显的证据是**同一个文件里两条路径的判据不一致**：
 * 流末尾那条分支写的是 `if (payload && payload !== "[DONE]")`（有非空判断），
 * 逐行分支却没有。两处行为不一致，说明其中一处一定写错了。
 *
 * `done` 必须是**终止**而不是"跳过"：结束标记之后服务商若还发了什么
 * （有些网关会把错误帧排在后面），那些内容属于协议违规，继续消费它们
 * 只会把垃圾数据当成回答的一部分。
 */
function parseDataLine(line: string): SseOutcome {
  const payload = line.slice(5).trim();
  if (payload === "[DONE]") return { kind: "done" };
  if (payload === "") return { kind: "skip" };
  return { kind: "data", payload };
}

/**
 * 把 fetch 的 Response body 解析成一行行 SSE `data:` 负载。
 * 处理跨 chunk 断行、CRLF、以及 `[DONE]` 结束标记。
 */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔；这里按行处理，保留最后一段不完整行
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        const line = rawLine.replace(/\r$/, "");
        if (!line || line.startsWith(":")) continue; // 空行或注释（心跳）
        if (!line.startsWith("data:")) continue;
        const outcome = parseDataLine(line);
        if (outcome.kind === "done") {
          finished = true;
          break;
        }
        if (outcome.kind === "skip") continue;
        yield outcome.payload;
      }
    }
    if (finished) return;

    /*
     * 流结束时必须**再 flush 一次解码器**。
     *
     * `decode(chunk, { stream: true })` 会把不完整的多字节字符留在解码器
     * 内部等后续字节补齐。如果流恰好在半个字符处结束（响应最后一个字是中文、
     * 且被 TCP 分片切在那里），那几个字节就永远留在解码器里被丢掉 ——
     * 表现为"回答的最后一个字不见了"，而且只在特定分片下复现。
     */
    buffer += decoder.decode();
    // 流结束时 buffer 里可能还剩一行没有换行符的 data 行
    const tail = buffer.replace(/\r$/, "");
    if (tail.startsWith("data:")) {
      const outcome = parseDataLine(tail);
      if (outcome.kind === "data") yield outcome.payload;
    }
  } finally {
    reader.releaseLock();
  }
}

/** 安全 JSON 解析：流里个别坏帧不应该炸掉整轮对话 */
export function parseJsonSafe<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 拼接 baseUrl 与路径，容忍两端任意的斜杠写法 */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
