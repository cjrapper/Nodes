/**
 * `describeHttpError` 的回归测试。
 *
 * 这个函数的输出是用户唯一能看到的失败原因，所以它必须：
 *  1. 尽量保留服务商原文（那是唯一的事实来源）；
 *  2. 在可识别的高频错因上追加一句"该怎么改"。
 *
 * 真实触发过的一次：用户把配置显示名 `DeepSeek-V4.1-Flash` 填进了模型 ID
 * 字段，服务商返回 400 并列出真正支持的模型名。原文虽然准确，但用户未必
 * 能把"我填的那个名字"和"接口模型名"对上号 —— 所以要在错误里直接点破。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { describeHttpError } from "../../src/lib/providers/types.ts";

test("保留服务商原文（那是唯一的事实来源）", () => {
  const body = JSON.stringify({ error: { message: "rate limit exceeded" } });
  const message = describeHttpError(429, body);
  assert.match(message, /rate limit exceeded/);
  assert.match(message, /^HTTP 429/);
});

test("支持 OpenAI 风格 { error: { message } }", () => {
  const message = describeHttpError(400, JSON.stringify({ error: { message: "bad param" } }));
  assert.match(message, /bad param/);
});

test("支持 { message } 与 error 为字符串两种形态", () => {
  assert.match(describeHttpError(500, JSON.stringify({ message: "boom" })), /boom/);
  assert.match(describeHttpError(500, JSON.stringify({ error: "plain" })), /plain/);
});

test("非 JSON 响应体直接截取原文，不丢信息", () => {
  const message = describeHttpError(502, "<html>Bad Gateway</html>");
  assert.match(message, /Bad Gateway/);
});

test("空响应体也要给出可读信息，不能只剩一个状态码就没了", () => {
  const message = describeHttpError(503, "");
  assert.match(message, /HTTP 503/);
});

test("模型 ID 填错时追加可操作提示", () => {
  // 这是真实抓到的响应体
  const body = JSON.stringify({
    error: {
      message:
        "The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed DeepSeek-V4.1-Flash.",
    },
  });
  const message = describeHttpError(400, body);
  assert.match(message, /supported API model names/, "必须保留服务商列出的可用模型名");
  assert.match(message, /模型 ID/, "必须指出是模型 ID 字段的问题");
  assert.match(message, /不是配置显示名/, "必须点破「显示名 ≠ 模型名」这个具体误解");
});

test("模型不存在的其它说法也能识别", () => {
  for (const text of [
    "model not found",
    "Invalid model: gpt-5",
    "The model `x` does not exist",
  ]) {
    const message = describeHttpError(400, JSON.stringify({ error: { message: text } }));
    assert.match(message, /模型 ID/, `未能识别：${text}`);
  }
});

test("401/403 提示检查 Key 与 baseUrl", () => {
  const message = describeHttpError(401, JSON.stringify({ error: { message: "unauthorized" } }));
  assert.match(message, /API Key/);
});

test("404 提示检查 baseUrl 的 /v1", () => {
  const message = describeHttpError(404, "not found");
  assert.match(message, /baseUrl/);
  assert.match(message, /v1/);
});

test("stream_options 不兼容时给出关闭方式", () => {
  const message = describeHttpError(
    400,
    JSON.stringify({ error: { message: "unknown field: stream_options" } }),
  );
  assert.match(message, /stream_options/);
  assert.match(message, /关闭/);
});

test("上下文超限时提示减少引用或新建对话", () => {
  const message = describeHttpError(
    400,
    JSON.stringify({ error: { message: "This model's maximum context length is 64000 tokens" } }),
  );
  assert.match(message, /上下文|对话|知识块/);
});

test("无法识别的错误不硬加提示（避免噪音）", () => {
  const message = describeHttpError(
    400,
    JSON.stringify({ error: { message: "some totally unrelated complaint" } }),
  );
  assert.equal(message, "HTTP 400: some totally unrelated complaint");
});

test("状态码优先级高于错误体内容（401 不会被模型名规则抢走）", () => {
  // 万一服务商在 401 里也提到了 model 字样，也应给出认证相关的提示
  const message = describeHttpError(401, JSON.stringify({ error: { message: "invalid model" } }));
  assert.match(message, /API Key/);
});

test("长错误体被截断，不会把整个响应塞进界面", () => {
  const message = describeHttpError(500, "x".repeat(5000));
  assert.ok(message.length < 1200, `实际长度 ${message.length}`);
});
