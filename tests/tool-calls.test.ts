/**
 * 工具调用累积器的回归测试。
 *
 * ## 为什么这个文件必须存在
 *
 * 「把流式分片拼成一个完整调用」这件事有四个坑，每一个都有真实的 bug 记录，
 * 而且**每一个都不会报错** —— 只会让工具拿到错的参数、或者名不对。
 * 所以这里每条断言都直接对着一个具体坑写，注释里写清"不这样会怎样"。
 *
 * 判据来源：DeepSeek 官方 harness 记录的线上分片序列，以及
 * deepseek-harness discussions #2090 / #3281 / #4370（都是 "
 * 续片把 id/name 重发成 ''/null → 工具名丢了" 这一类）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ToolCallAccumulator, parseToolArgs } from "../src/lib/providers/tool-calls.ts";

/** 官方 harness 记录的真实分片序列（get_weather，参数分三片到达） */
function officialFragments() {
  return [
    {
      index: 0,
      id: "call_00_x",
      name: "get_weather",
      argsDelta: "",
    },
    { index: 0, argsDelta: '{"city"' },
    { index: 0, argsDelta: ': "Paris"}' },
  ];
}

test("按 index 归并：续片只给 index 和 arguments 也能拼出完整调用", () => {
  const acc = new ToolCallAccumulator();
  for (const frag of officialFragments()) acc.push(frag);

  const { calls, dropped } = acc.finish();
  assert.equal(dropped, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "call_00_x");
  assert.equal(calls[0].name, "get_weather");
  assert.equal(
    calls[0].argsText,
    '{"city": "Paris"}',
    "参数必须是分片**原样拼接**的结果，不能重新序列化",
  );
});

/**
 * 坑 1：同一 chunk 里 index:1 可能先于 index:0 到达。
 * 按数组下标累积会把两个调用的参数串混在一起。
 */
test("并行调用乱序到达：按 index 归并而不是按到达顺序", () => {
  const acc = new ToolCallAccumulator();
  // 故意让 index 1 先到
  acc.push({ index: 1, id: "call_b", name: "search_blocks", argsDelta: '{"query"' });
  acc.push({ index: 0, id: "call_a", name: "list_docs", argsDelta: "{}" });
  acc.push({ index: 1, argsDelta: ': "GC"}' });

  const { calls } = acc.finish();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "list_docs", "产出必须按 index 升序，顺序要对得上 tool 消息");
  assert.equal(calls[0].argsText, "{}");
  assert.equal(calls[1].name, "search_blocks");
  assert.equal(calls[1].argsText, '{"query": "GC"}');
});

/**
 * 坑 2（最容易中招）：续片把 id/name 重发成空串或 null，语义是"没变化"。
 * 用它覆盖首片值 → 工具名变成 ""，上层只能报"未知工具"。
 */
test("续片重发空的 id/name 不得覆盖首片值", () => {
  const acc = new ToolCallAccumulator();
  acc.push({ index: 0, id: "call_1", name: "create_doc", argsDelta: '{"title"' });
  acc.push({ index: 0, id: "", name: "", argsDelta: ': "笔记"}' });
  // 第三片把 id/name 明确发成 null（部分网关就是这么干的）
  acc.push({ index: 0, id: null as unknown as undefined, name: null as unknown as undefined });

  const { calls, dropped } = acc.finish();
  assert.equal(dropped, 0);
  assert.equal(calls[0].name, "create_doc", "空 name 不能被当成'改成了空'");
  assert.equal(calls[0].id, "call_1", "空 id 同理，丢了 id 这条调用就没法回传结果");
  assert.equal(calls[0].argsText, '{"title": "笔记"}');
});

test("没有 id 或没有 name 的调用被丢弃并计数，而不是发一个空 id 回去", () => {
  const acc = new ToolCallAccumulator();
  acc.push({ index: 0, name: "no_id_tool", argsDelta: "{}" }); // 缺 id
  acc.push({ index: 1, id: "call_x", argsDelta: "{}" }); // 缺 name

  const { calls, dropped } = acc.finish();
  assert.equal(calls.length, 0, "发空 tool_call_id 回去会被服务商 400");
  assert.equal(
    dropped,
    2,
    "必须计数 —— 静默丢弃会让'模型调了工具但没执行'变成无头案",
  );
});

test("没有参数的调用按 {} 兜底，不会让下游 JSON.parse('') 抛错", () => {
  const acc = new ToolCallAccumulator();
  acc.push({ index: 0, id: "call_1", name: "list_docs" }); // 一个 arguments 分片都没有

  const { calls } = acc.finish();
  assert.equal(calls[0].argsText, "{}");
  const parsed = parseToolArgs(calls[0].argsText);
  assert.equal(parsed.ok, true);
});

test("reset 之后不残留上一轮的分片", () => {
  const acc = new ToolCallAccumulator();
  acc.push({ index: 0, id: "call_1", name: "a", argsDelta: "{}" });
  assert.equal(acc.size, 1);
  acc.reset();
  assert.equal(acc.size, 0);
  assert.deepEqual(acc.finish().calls, []);
});

/* ------------------------------------------------------------------ *
 * 参数解析：失败必须可读
 * ------------------------------------------------------------------ */

test("参数非法时给出可读原因和原始内容，而不是裸的 SyntaxError", () => {
  // 真实场景：模型输出被 max_tokens 截断，参数是半截 JSON
  const parsed = parseToolArgs('{"query": "内存');
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /不是合法 JSON/);
  assert.match(
    parsed.error,
    /内存/,
    "必须带上原始内容 —— 否则用户和日志都不知道模型到底生成了什么",
  );
});

test("参数是数组或标量时明确报错（模型确实会这么干）", () => {
  for (const bad of ["[1,2]", '"just a string"', "42", "null"]) {
    const parsed = parseToolArgs(bad);
    assert.equal(parsed.ok, false, `${bad} 不是对象，应当被拒绝`);
  }
});

test("空参数串是合法的（= 无参数），不是错误", () => {
  const parsed = parseToolArgs("");
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.args, {});
});
