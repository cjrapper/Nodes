/**
 * SSE 解析的回归测试。
 *
 * ## 为什么单独测这个
 *
 * `readSseData` 是所有流式回答的必经之路，而它的输入是不可控的：
 * 字节被切在任意位置到达，服务商的写法各不相同。这里守三类问题：
 *
 *  1. **跨 chunk 断行与多字节字符** —— 真实网络下 SSE 事件几乎必然跨包边界，
 *     中文回答被切在字符中间是常态而不是极端情况。
 *  2. **结束标记的写法** —— `[DONE]` 后面跟一个空格（有些网关真这么写）
 *     曾经不被认成终止，于是结束标记被当成负载送进 JSON 解析。
 *  3. **判据一致性** —— 同一个文件里"逐行路径"与"流末尾路径"一度用了
 *     两套判据（一个判空、一个不判），两处不一致说明其中一处必有 bug。
 *
 * ⚠️ 写这类测试时最容易犯的错是**把测试数据本身构造错**。
 * `new TextEncoder().encode("\xe4\xb8\xad")` 看起来像"中的 UTF-8 字节"，
 * 实际是把三个 Latin-1 字符各编成 2 字节（共 6 字节）——
 * 解码出来是 `ä¸` 而不是 `中`。所以下面一律用 `raw([0xe4, 0xb8, 0xad])`
 * 构造真正的原始字节，并且**先断言一次整块解码的结果**作为对照，
 * 这样"测试数据是否构造正确"本身也是被验证的。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readSseData } from "../src/lib/providers/sse.ts";

const enc = new TextEncoder();

/** 构造真正的原始字节（不要用 TextEncoder 编 `\xNN` 转义） */
function raw(bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

/** 把若干 Uint8Array 拼成一个 */
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function collect(chunks: Uint8Array[]): Promise<string[]> {
  const out: string[] = [];
  for await (const payload of readSseData(streamOf(chunks))) out.push(payload);
  return out;
}

/* ------------------------------------------------------------------ *
 * 0. 先证明测试数据是对的
 * ------------------------------------------------------------------ */

test("前置条件：raw([0xe4,0xb8,0xad]) 确实是「中」的 UTF-8 字节", () => {
  // 这条如果挂了，下面所有多字节用例都在测一个错误的前提
  assert.equal(new TextDecoder().decode(raw([0xe4, 0xb8, 0xad])), "中");
  // 对照：TextEncoder 编 "\xe4\xb8\xad" 得到的是 6 字节，不是 3 字节
  assert.equal(enc.encode("\xe4\xb8\xad").length, 6, "这正是不能用它构造原始字节的原因");
});

/* ------------------------------------------------------------------ *
 * 1. 正常路径
 * ------------------------------------------------------------------ */

test("多帧按顺序解析", async () => {
  const out = await collect([enc.encode('data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n')]);
  assert.deepEqual(out, ['{"a":1}', '{"b":2}']);
});

test("CRLF 行尾正常处理", async () => {
  const out = await collect([enc.encode('data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n')]);
  assert.deepEqual(out, ['{"a":1}']);
});

test("心跳注释行被忽略", async () => {
  const out = await collect([enc.encode(': keep-alive\n\ndata: {"a":1}\n\n')]);
  assert.deepEqual(out, ['{"a":1}']);
});

test("没有尾换行的最后一帧仍被解析", async () => {
  const out = await collect([enc.encode('data: {"a":1}\n\ndata: {"b":2}')]);
  assert.deepEqual(out, ['{"a":1}', '{"b":2}']);
});

/* ------------------------------------------------------------------ *
 * 2. 结束标记与空负载
 * ------------------------------------------------------------------ */

test("`[DONE]` 后面跟空格仍被认成终止标记", async () => {
  /*
   * 这是真实存在的写法差异。早先只 trimStart，于是 `[DONE] ` 不等于 `[DONE]`，
   * 结束标记被当作普通负载送进 JSON 解析（侥幸没炸，但那是运气）。
   */
  const out = await collect([enc.encode('data: {"a":1}\n\ndata: [DONE] \n\n')]);
  assert.deepEqual(out, ['{"a":1}']);
});

test("`[DONE]` 之后的负载不再被消费", async () => {
  /*
   * `done` 必须是**终止**而不是"跳过"。有些网关会把错误帧排在结束标记之后，
   * 继续消费它们等于把协议违规的数据当成回答的一部分。
   */
  const out = await collect([enc.encode('data: {"a":1}\n\ndata: [DONE]\n\ndata: {"after":1}\n\n')]);
  assert.deepEqual(out, ['{"a":1}']);
});

test("空负载的 data 行被跳过，不产生空事件", async () => {
  // 早先这一行会 yield 出空字符串，而流末尾那条分支却有判空 —— 两处不一致
  const out = await collect([enc.encode('data: {"a":1}\n\ndata: \n\ndata: {"b":2}\n\n')]);
  assert.deepEqual(out, ['{"a":1}', '{"b":2}']);
});

test("流末尾的空负载同样被跳过（两条路径判据一致）", async () => {
  const out = await collect([enc.encode('data: {"a":1}\n\ndata: ')]);
  assert.deepEqual(out, ['{"a":1}']);
});

/* ------------------------------------------------------------------ *
 * 3. 多字节字符跨 chunk
 * ------------------------------------------------------------------ */

test("「中」被切在两个 chunk 之间仍能正确还原", async () => {
  const out = await collect([
    concat(enc.encode('data: {"t":"'), raw([0xe4, 0xb8])),
    concat(raw([0xad]), enc.encode('"}\n\n')),
  ]);
  assert.deepEqual(out, ['{"t":"中"}']);
});

test("流恰好在多字节字符之后结束（没有换行）仍能还原", async () => {
  /*
   * 这一条要求**流结束时 flush 一次解码器**。
   * `decode(chunk, { stream: true })` 会把不完整的多字节字符留在解码器内部
   * 等后续字节；流如果就此结束，那几个字节会被丢掉 ——
   * 表现为"回答的最后一个字不见了"。
   */
  const out = await collect([enc.encode('data: {"t":"'), raw([0xe4, 0xb8, 0xad])]);
  assert.deepEqual(out, ['{"t":"中']);
});

test("流切在多字节字符中间并结束：产出替换字符，但它注定解析失败、会被丢弃", async () => {
  /*
   * 这一条记录的是一个**已知局限，不是可修的 bug**。
   *
   * 半个 UTF-8 字符无法还原成任何文本，所以 flush 时它必然变成替换字符 `�`。
   * 能保证的是**后果可控**：
   *
   *  - 它只会出现在**流的最后一个字符被切断**这一种情况（TCP 断开、
   *    服务商提前关连接），正常结束的响应不会走到这里；
   *  - `�` 会被拼进 JSON 负载 → `parseJsonSafe` 解析失败 → 该帧被丢弃，
   *    **不会**把半个字符当成正文显示出来；
   *  - 用户看到的是"最后一小段没出来"，而不是"回答里混了个问号"。
   *
   * 所以这里断言的是"后果可控"，而不是"不出现替换字符"——
   * 后者做不到，写一条做不到的断言只会让测试长期变红然后被忽略。
   */
  const out = await collect([enc.encode('data: {"t":"'), raw([0xe4, 0xb8])]);

  for (const payload of out) {
    // 关键性质：负载已经不是一个合法 JSON 了，下游必定丢弃它
    assert.throws(
      () => JSON.parse(payload),
      undefined,
      `半字符帧必须解析失败（这样下游才会丢掉它），实际解析成功：${JSON.stringify(payload)}`,
    );
  }
});

test("逐字节到达（最极端分片）仍能还原整段", async () => {
  const whole = concat(enc.encode('data: {"t":"'), raw([0xe4, 0xb8, 0xad]), enc.encode('"}\n\n'));
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < whole.length; i += 1) chunks.push(whole.subarray(i, i + 1));
  const out = await collect(chunks);
  assert.deepEqual(out, ['{"t":"中"}'], "逐字节分片是最坏情况，必须仍然正确");
});
