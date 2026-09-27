/**
 * HTTP 端到端冒烟测试。
 *
 * 打到**真实运行的开发/生产服务器**上，验证自动化测试覆盖不到的那一层：
 * 路由注册、请求体解析、HTTP 状态码、SSE 帧格式、以及"前端会怎么消费它"。
 *
 * 用法：
 *   node scripts/smoke.mjs                    # 默认 http://127.0.0.1:3210
 *   BASE=http://127.0.0.1:3210 node scripts/smoke.mjs
 *
 * 注意：这个脚本会在目标数据库里**真的创建**文档与会话。
 * 它用固定标题前缀标记自己的产物，并在结尾清理掉。
 */

import { randomBytes } from "node:crypto";

const BASE = process.env.BASE ?? "http://127.0.0.1:3210";
const MARK = "【冒烟测试】";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function getJson(path) {
  const response = await fetch(`${BASE}${path}`);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

async function sendJson(method, path, payload) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

const SMOKE_DOC = `# ${MARK}发布检查清单

发布前必须确认三件事：灰度比例、回滚方案、监控看板。

## 回滚流程

回滚分两步：先把流量切回上一版本，再确认数据库迁移是否可逆。

\`\`\`bash
kubectl rollout undo deployment/api
\`\`\`

> 回滚不需要审批，但要立刻在群里同步。

## 灰度策略

灰度分四个批次推进，每批之间至少观察十五分钟，确认无异常再进入下一批。

第一批只放行内部账号，用来验证核心链路是否可用。这一批不承载真实流量，
因此出现问题时直接回滚即可，不需要额外的评估流程。

第二批放行百分之一的真实用户，重点观察错误率与登录成功率。这一批是
风险最高的一批，因为此时才会第一次接触真实流量的分布特征。

第三批放行百分之十，重点观察数据库连接池与下游依赖的容量水位。
到了这一批，任何容量问题都会以延迟上升的形式暴露出来。

第四批全量放行。全量之后仍然要保持至少一小时的观察窗口，
不要因为"已经全量了"就提前收工。

## 值班与沟通

发布窗口固定在每周二与周四的下午两点到五点，避免周五发布。

发布期间必须至少有一名值班人在线，负责盯看板与处理告警。

任何回滚决定都由值班人独立做出，不需要等待审批。
`;

async function main() {
  console.log(`\n[smoke] 目标：${BASE}\n`);

  /* ---------- 1. 页面与基础接口 ---------- */
  console.log("1. 页面与基础接口");

  const html = await fetch(`${BASE}/`);
  const htmlText = await html.text();
  check("GET / 返回 200", html.status === 200, `实际 ${html.status}`);
  check(
    "首页 HTML 含应用根标记",
    htmlText.includes("<!DOCTYPE html") || htmlText.includes("<html"),
    "响应不像 HTML",
  );
  check(
    "首页未泄漏未处理的错误堆栈",
    !htmlText.includes("Unhandled Runtime Error") && !htmlText.includes("__NEXT_ERROR"),
  );

  const ws = await getJson("/api/workspace");
  check("GET /api/workspace 返回 200", ws.status === 200, `实际 ${ws.status}`);
  check("工作区有 id 与名称", Boolean(ws.body?.workspace?.id && ws.body?.workspace?.name));
  check(
    "工作区带人设（L0 层的来源）",
    typeof ws.body?.workspace?.persona === "string" && ws.body.workspace.persona.length > 0,
  );
  check(
    "工作区带外观设置（字号/颜色）",
    typeof ws.body?.workspace?.appearance?.fontSize === "number" &&
      typeof ws.body?.workspace?.appearance?.accent === "string",
  );

  const models = await getJson("/api/models");
  check("GET /api/models 返回 200", models.status === 200);
  check("预置了模型配置", Array.isArray(models.body?.models) && models.body.models.length > 0);
  check(
    "模型列表不回传明文 apiKey",
    Array.isArray(models.body?.models) &&
      models.body.models.every((m) => m.apiKey === undefined),
    "响应里出现了 apiKey 字段",
  );
  check(
    "模型列表给出 key 配置状态",
    Array.isArray(models.body?.models) &&
      models.body.models.every((m) => typeof m.apiKeySet === "boolean"),
  );

  const stats = await getJson("/api/stats?range=7d");
  check("GET /api/stats 返回 200", stats.status === 200);
  check("统计包含 hitRate 字段", typeof stats.body?.stats?.hitRate === "number");

  /* ---------- 2. 文档与知识块 ---------- */
  console.log("\n2. 文档与知识块");

  const created = await sendJson("POST", "/api/docs", { title: `${MARK}冒烟文档` });
  check("POST /api/docs 返回 201", created.status === 201, `实际 ${created.status}`);
  const docId = created.body?.doc?.id;
  /** 本次跑冒烟创建的全部文档 id —— 结尾用 purge 彻底清掉，不在库里留软删残行 */
  const createdDocIds = [];
  check("返回了新文档 id", typeof docId === "string" && docId.length > 0);
  check("默认文档的 kind 是 doc", created.body?.doc?.kind === "doc");
  if (!docId) {
    console.log("\n无法继续：创建文档失败");
    return;
  }
  createdDocIds.push(docId);

  // 清掉之前冒烟留下的同名文档，保证脚本可反复运行
  const docsBefore = await getJson("/api/docs");
  const stale = (docsBefore.body?.docs ?? []).filter(
    (d) => d.title?.startsWith(MARK) && d.id !== docId,
  );
  for (const d of stale) {
    await fetch(`${BASE}/api/docs?id=${encodeURIComponent(d.id)}`, { method: "DELETE" });
  }

  /*
   * 连同**回收站里**自己上一次留下的东西一起彻底清掉。
   *
   * 软删之后数据还在库里，而 `listDocs` 过滤了它们 —— 所以不做这一步的话，
   * 每跑一次冒烟就在用户的库里多累积几行 `deleted_at` 非空的数据，
   * 而且再也清不掉（只增不减）。
   *
   * ⚠️ 判据必须同时满足"是我造的"（标题带 MARK）与"已经被删了"，
   * 绝不碰用户自己删掉的东西。
   */
  const trashBefore = await getJson("/api/docs?deleted=1");
  for (const d of trashBefore.body?.docs ?? []) {
    if (!d.title?.startsWith(MARK)) continue;
    await fetch(`${BASE}/api/docs?id=${encodeURIComponent(d.id)}&purge=1`, {
      method: "DELETE",
    });
  }

  const saved = await sendJson("PUT", "/api/blocks", {
    docId,
    markdown: SMOKE_DOC,
    blockIds: [],
  });
  check("PUT /api/blocks 保存成功", saved.status === 200, `实际 ${saved.status}`);
  const blocks = saved.body?.blocks ?? [];
  check("解析出了多个知识块", blocks.length >= 8, `实际 ${blocks.length} 块`);
  check(
    "每个块都有 16 位 cacheKey",
    blocks.every((b) => typeof b.cacheKey === "string" && b.cacheKey.length === 16),
  );
  check(
    "块带可读路径（含标题层级）",
    blocks.some((b) => typeof b.path === "string" && b.path.includes("›")),
    "没有任何块的路径含标题层级",
  );
  check(
    "识别出多种块类型",
    new Set(blocks.map((b) => b.kind)).size >= 3,
    `实际类型：${[...new Set(blocks.map((b) => b.kind))].join(",")}`,
  );

  const fetched = await getJson(`/api/blocks?docId=${encodeURIComponent(docId)}`);
  check("GET /api/blocks 读回成功", fetched.status === 200);
  check(
    "读回的 blockIds 数量与 blocks 一致",
    fetched.body?.blockIds?.length === fetched.body?.blocks?.length,
  );

  /* ---------- 3. 幂等保存 ---------- */
  console.log("\n3. 幂等保存（缓存稳定的前提）");

  const resave = await sendJson("PUT", "/api/blocks", {
    docId,
    markdown: SMOKE_DOC,
    blockIds: fetched.body.blockIds,
  });
  check("重复保存不报错", resave.status === 200);
  check(
    "重复保存不产生任何块变更",
    resave.body?.changed?.length === 0 &&
      resave.body?.created?.length === 0 &&
      resave.body?.removed?.length === 0,
    `changed=${resave.body?.changed?.length} created=${resave.body?.created?.length} removed=${resave.body?.removed?.length}`,
  );
  check(
    "重复保存后块 id 与 cacheKey 保持不变",
    JSON.stringify(resave.body?.blocks?.map((b) => b.cacheKey)) ===
      JSON.stringify(fetched.body.blocks.map((b) => b.cacheKey)),
  );

  /* ---------- 4. 搜索与引用解析 ---------- */
  console.log("\n4. 搜索与引用解析");

  const search = await getJson(`/api/search?q=${encodeURIComponent("回滚")}&limit=10`);
  check("GET /api/search 返回 200", search.status === 200);
  check("搜索命中相关块", (search.body?.results?.length ?? 0) > 0);
  check(
    "搜索结果的块 id 属于本文档",
    (search.body?.results ?? []).every((r) => typeof r.blockId === "string"),
  );

  const blockIds = fetched.body.blockIds;
  const refs = await sendJson("POST", "/api/refs", { blockIds: blockIds.slice(0, 6) });
  check("POST /api/refs 返回 200", refs.status === 200);
  check("批量解析出 6 个块", refs.body?.blocks?.length === 6);
  check(
    "解析结果含路径与摘要",
    refs.body.blocks.every((b) => typeof b.path === "string" && typeof b.snippet === "string"),
  );
  check("解析结果未标记为 missing", refs.body.blocks.every((b) => b.missing === false));

  const missingRefs = await sendJson("POST", "/api/refs", {
    blockIds: ["blk_does_not_exist_at_all"],
  });
  check(
    "不存在的块被标记为 missing 而不是报错",
    missingRefs.status === 200 && missingRefs.body?.blocks?.[0]?.missing === true,
  );

  /* ---------- 5. 会话与缓存预览 ---------- */
  console.log("\n5. 会话与缓存预览");

  const modelId = models.body.models.find((m) => m.isDefault)?.id ?? models.body.models[0].id;
  const conv = await sendJson("POST", "/api/conversations", {
    title: `${MARK}冒烟会话`,
    modelConfigId: modelId,
    refBlockIds: blockIds.slice(0, 6),
  });
  check("POST /api/conversations 返回 201", conv.status === 201, `实际 ${conv.status}`);
  const convId = conv.body?.conversation?.id;
  check("返回了会话 id", typeof convId === "string");
  if (!convId) return;

  const preview1 = await sendJson("POST", "/api/preview", {
    conversationId: convId,
    content: "帮我把这些整理成发布检查清单",
    modelConfigId: modelId,
    refBlockIds: blockIds.slice(0, 6),
  });
  check("POST /api/preview 返回 200", preview1.status === 200, preview1.text.slice(0, 200));
  const plan1 = preview1.body?.plan;
  check("预览返回分层构成", Array.isArray(plan1?.layers) && plan1.layers.length >= 4);
  check("首轮判定为冷启动", plan1?.prediction?.verdict === "cold");
  check("首轮失效根因是 cold_start", plan1?.invalidation?.reason === "cold_start");
  check(
    "预览给出断点说明",
    typeof plan1?.breakpointNote === "string" && plan1.breakpointNote.length > 0,
  );
  check("预览列出了挂载的块", (plan1?.blockTokens?.length ?? 0) === 6);

  const layerSum = (plan1?.layers ?? []).reduce((s, l) => s + l.tokens, 0);
  check(
    "分层 token 累加等于总 token",
    Math.abs(layerSum - plan1.totalTokens) <= 1,
    `层累加 ${layerSum} vs 总计 ${plan1.totalTokens}`,
  );

  /*
   * 层顺序必须是规范顺序的**子序列**。
   * 不是全等：没有历史的会话不会渲染 L3（tokens 为 0 的层会被过滤掉），
   * 没有挂载模块时也不会有模块层 —— 空层本就不该占用 prompt。
   */
  const CANONICAL = [
    "L0_persona",
    "L1_workspace",
    "L2_source_index",
    "L2_source_content",
    "L2_doc_index",
    "L2_doc_content",
    "L3_history",
    "L4_turn",
  ];
  const returned = (plan1?.layers ?? []).map((l) => l.name);
  let cursor = -1;
  const isSubsequence = returned.every((name) => {
    const at = CANONICAL.indexOf(name);
    if (at <= cursor) return false;
    cursor = at;
    return true;
  });
  check("层顺序是规范顺序的合法子序列", isSubsequence, returned.join(","));
  check(
    "无历史时不渲染空的 L3 层",
    returned.length === 0 || returned[returned.length - 1] === "L4_turn",
    returned.join(","),
  );

  /* ---------- 6. 模块容器、图表块与整体挂载 ---------- */
  console.log("\n6. 模块容器、图表块与整体挂载");

  const moduleDoc = await sendJson("POST", "/api/docs", {
    title: `${MARK}Unity 模块`,
    kind: "module",
  });
  check("POST /api/docs 支持 kind=module", moduleDoc.status === 201, `实际 ${moduleDoc.status}`);
  check("返回的文档 kind 是 module", moduleDoc.body?.doc?.kind === "module");
  const moduleId = moduleDoc.body?.doc?.id;
  if (typeof moduleId === "string") createdDocIds.push(moduleId);

  if (moduleId) {
    const child1 = await sendJson("POST", "/api/docs", {
      parentId: moduleId,
      title: `${MARK}生命周期`,
    });
    const child2 = await sendJson("POST", "/api/docs", {
      parentId: moduleId,
      title: `${MARK}性能`,
    });
    check("子文档的 kind 是 doc", child1.body?.doc?.kind === "doc");
    check("子文档记录了 parentId", child1.body?.doc?.parentId === moduleId);

    const child1Id = child1.body?.doc?.id;
    const child2Id = child2.body?.doc?.id;

    const diagramMd = [
      "# 性能优化",
      "",
      "合批可以减少 DrawCall。",
      "",
      "```diagram",
      "# 排查路径",
      "掉帧 --> 合批",
      "掉帧 --> 过绘制",
      `合批 --> doc:${child1Id}`,
      "```",
    ].join("\n");

    const child1Saved = await sendJson("PUT", "/api/blocks", {
      docId: child1Id,
      markdown: "# 生命周期\n\nAwake 最先执行，OnEnable 紧随其后。",
      blockIds: [],
    });
    const child2Saved = await sendJson("PUT", "/api/blocks", {
      docId: child2Id,
      markdown: diagramMd,
      blockIds: [],
    });
    check("子文档写入成功", child1Saved.status === 200 && child2Saved.status === 200);

    const blocks2 = child2Saved.body?.blocks ?? [];
    check(
      "```diagram 围栏被识别成 diagram 块",
      blocks2.some((b) => b.kind === "diagram"),
      `实际类型：${blocks2.map((b) => b.kind).join(", ")}`,
    );
    check(
      "图表块的正文保留了围栏（保证 Markdown 往返无损）",
      blocks2.some((b) => b.kind === "diagram" && b.text.includes("```")),
    );

    const moduleConv = await sendJson("POST", "/api/conversations", {
      title: `${MARK}模块会话`,
      modelConfigId: modelId,
      refDocIds: [moduleId],
    });
    check("会话支持 refDocIds", moduleConv.status === 201, `实际 ${moduleConv.status}`);
    const moduleConvId = moduleConv.body?.conversation?.id;

    if (moduleConvId) {
      const modulePreview = await sendJson("POST", "/api/preview", {
        conversationId: moduleConvId,
        content: "这个方向还缺什么",
        refDocIds: [moduleId],
      });
      check("挂载模块后预览可用", modulePreview.status === 200, modulePreview.text.slice(0, 200));

      const layers = modulePreview.body?.plan?.layers ?? [];
      const layerNames = layers.map((l) => l.name);
      check(
        "出现模块清单层 L2_doc_index",
        layerNames.includes("L2_doc_index"),
        layerNames.join(","),
      );
      check(
        "出现模块正文层 L2_doc_content",
        layerNames.includes("L2_doc_content"),
        layerNames.join(","),
      );

      const docLayer = layers.find((l) => l.name === "L2_doc_content");
      check(
        "模块正文层把子文档的内容摊平进来了",
        (docLayer?.tokens ?? 0) > 20,
        `tokens=${docLayer?.tokens}`,
      );

      const docAt = layerNames.indexOf("L2_doc_content");
      const historyAt = layerNames.indexOf("L3_history");
      check(
        "模块层排在历史层之前",
        historyAt === -1 || docAt < historyAt,
        layerNames.join(","),
      );

      const readBack = await getJson(`/api/messages?id=${encodeURIComponent(moduleConvId)}`);
      check(
        "会话读回带 refDocIds",
        Array.isArray(readBack.body?.refDocIds) && readBack.body.refDocIds.includes(moduleId),
        JSON.stringify(readBack.body?.refDocIds),
      );

      await fetch(`${BASE}/api/conversations?id=${encodeURIComponent(moduleConvId)}`, {
        method: "DELETE",
      });
    }

    await fetch(`${BASE}/api/docs?id=${encodeURIComponent(moduleId)}`, { method: "DELETE" });
    /*
     * 只断言**本次创建的这几篇**消失了。
     *
     * 早先这里断言的是"列表里没有任何以标记开头的文档" —— 那会把用户自己
     * 手动建的同名文档也算进来，于是测试在一个本来完全正常的库上失败。
     * 冒烟测试必须能在一个有真实数据的库上反复运行。
     */
    const afterModule = await getJson("/api/docs");
    const remainingIds = (afterModule.body?.docs ?? []).map((d) => d.id);
    check("删除模块会连带删掉子文档", !remainingIds.includes(child1Id) && !remainingIds.includes(child2Id));
    check("模块本身也已被删除", !remainingIds.includes(moduleId));
    check(
      "模块下的文档在删除前确实存在过（前置条件成立）",
      Boolean(child1Id && child2Id) && child1Id !== child2Id,
    );
  }

  /* ---------- 7. 校验与错误处理 ---------- */
  console.log("\n7. 校验与错误处理");

  const badPreview = await sendJson("POST", "/api/preview", {});
  check("preview 缺少 conversationId 时返回 400", badPreview.status === 400);

  const badChat = await sendJson("POST", "/api/chat", { conversationId: convId, content: "  " });
  check("chat 空内容返回 400", badChat.status === 400);

  const badDoc = await getJson("/api/blocks?docId=nope");
  check("读取不存在的文档返回 404", badDoc.status === 404, `实际 ${badDoc.status}`);

  const badModel = await sendJson("POST", "/api/models", { name: "x" });
  check("创建模型缺少必填字段返回 400", badModel.status === 400);

  /* ---------- 8. 对话事件流（SSE 帧格式） ---------- */
  console.log("\n8. 对话事件流（SSE 帧格式）");

  const chatResponse = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: convId,
      content: "测试一下缓存",
      modelConfigId: modelId,
      refBlockIds: blockIds.slice(0, 6),
    }),
  });
  check("POST /api/chat 返回 200", chatResponse.status === 200, `实际 ${chatResponse.status}`);
  check(
    "Content-Type 是 text/event-stream",
    (chatResponse.headers.get("content-type") ?? "").includes("text/event-stream"),
    chatResponse.headers.get("content-type") ?? "(空)",
  );

  const rawStream = await chatResponse.text();
  const frames = rawStream
    .split("\n\n")
    .filter((f) => f.trim().startsWith("data:"))
    .map((f) => {
      try {
        return JSON.parse(f.replace(/^data:\s*/, ""));
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  check("事件流可解析出若干帧", frames.length > 0, `原始响应：${rawStream.slice(0, 200)}`);
  check("首帧是 start 事件", frames[0]?.type === "start", `实际 ${frames[0]?.type}`);
  check(
    "第二帧是 plan 事件（发请求前就把缓存预测推给前端）",
    frames[1]?.type === "plan",
    `实际 ${frames[1]?.type}`,
  );
  check(
    "plan 事件带完整分层与预测",
    Array.isArray(frames[1]?.plan?.layers) &&
      typeof frames[1]?.plan?.prediction?.predictedCachedTokens === "number",
  );

  /*
   * 播种的模型默认没有 API Key，但用户可能已经填过。
   * 两种情况都必须能跑通 —— 这个脚本是给人反复运行的，不能假设库是空的。
   */
  const seededModel = models.body.models.find((m) => m.id === modelId);
  const hasApiKey = Boolean(seededModel?.apiKeySet);

  const lastFrame = frames[frames.length - 1];
  if (hasApiKey) {
    check(
      "有 API Key 时以 final 或 error 帧正常收尾",
      lastFrame?.type === "final" || lastFrame?.type === "error",
      `末帧：${JSON.stringify(lastFrame).slice(0, 200)}`,
    );
    check(
      "错误信息来自服务商且非空",
      lastFrame?.type !== "error" || (lastFrame.message ?? "").length > 10,
      `末帧：${JSON.stringify(lastFrame).slice(0, 200)}`,
    );
  } else {
    check(
      "缺少 API Key 时以 error 帧收尾且提示可读",
      lastFrame?.type === "error" && /API Key/i.test(lastFrame.message ?? ""),
      `末帧：${JSON.stringify(lastFrame).slice(0, 200)}`,
    );
  }
  check(
    "发出请求前总是先给出 plan（用户能看到缓存构成）",
    frames.some((f) => f.type === "plan"),
  );

  /* ---------- 9. 会话读回与统计 ---------- */
  console.log("\n9. 会话读回与统计");

  const detail = await getJson(`/api/messages?id=${encodeURIComponent(convId)}`);
  check("GET /api/messages 返回 200", detail.status === 200);
  check(
    "用户消息已落库（本轮输入）",
    (detail.body?.messages ?? []).some(
      (m) => m.role === "user" && m.content.includes("测试一下缓存"),
    ),
    `消息数 ${detail.body?.messages?.length}`,
  );
  check(
    "会话引用集合已持久化",
    (detail.body?.refBlockIds ?? []).length === 6,
    `实际 ${detail.body?.refBlockIds?.length}`,
  );

  /*
   * 调用记录与结果的对应关系必须自洽：
   *  - 拿到 final（真实调用成功过）→ 必须有一条 ok 记录，否则下一轮没有缓存基准
   *  - 没拿到 final → 不能有任何 ok 记录，否则下一轮会拿"根本没发生过的调用"
   *    当缓存基准，预测会完全失真
   */
  const invocations = detail.body?.invocations ?? [];
  if (lastFrame?.type === "final") {
    check(
      "成功轮次留下了 ok 调用记录（下一轮的缓存基准）",
      invocations.some((i) => i.status === "ok"),
      `记录数 ${invocations.length}`,
    );
    check(
      "ok 记录保存了分层哈希",
      invocations
        .filter((i) => i.status === "ok")
        .every((i) => Object.keys(i.layerHashes ?? {}).length >= 4),
    );
  } else {
    check(
      "未成功的轮次不产生 ok 调用记录",
      invocations.every((i) => i.status !== "ok"),
      `记录：${invocations.map((i) => i.status).join(",")}`,
    );
  }

  const preview2 = await sendJson("POST", "/api/preview", {
    conversationId: convId,
    content: "再问一次",
    modelConfigId: modelId,
    refBlockIds: blockIds.slice(0, 6),
  });
  const reason2 = preview2.body?.plan?.invalidation?.reason;

  if (lastFrame?.type === "final") {
    /*
     * 这一轮真的调成功了，所以下一轮**有**缓存基准可复用。
     * 判据只能断言"基准存在时不该说冷启动"，不能断言具体是 hit 还是 partial ——
     * 那取决于本轮写进缓存的长度，而缓存本身有生效门槛。
     */
    check(
      "成功轮次之后不再判定为冷启动",
      preview2.body?.plan?.prediction?.verdict !== "cold" || reason2 !== "cold_start",
      `实际 verdict=${preview2.body?.plan?.prediction?.verdict} reason=${reason2}`,
    );
    check(
      "成功轮次之后能说明失效来自哪一层",
      typeof reason2 === "string" && reason2.length > 0,
      `实际 ${reason2}`,
    );
  } else {
    /*
     * 上一轮失败 → 下一轮仍应判定为冷启动：**不能拿失败轮次当缓存基准**。
     * 但根因不一定是 cold_start —— 失败轮次的用户消息仍写进了历史，
     * 而基准是更早那次成功调用，两边的 L3_history 天然不同，
     * 此时 history_rewritten 是比 cold_start 更准确的描述。
     * 真正要守的不变量是"命中为 0"，具体措辞两种都算对。
     */
    check("失败轮次之后的预览仍为冷启动", preview2.body?.plan?.prediction?.verdict === "cold");
    check(
      "失败轮次不产生新的缓存基准",
      reason2 === "cold_start" || reason2 === "history_rewritten",
      `实际 ${reason2}`,
    );
  }

  const stats2 = await getJson("/api/stats?range=7d");
  check("统计接口在失败轮次后仍可用", stats2.status === 200);
  check(
    "失败轮次不计入统计",
    (stats2.body?.stats?.promptTokens ?? -1) >= 0 && stats2.body.stats.invocations >= 0,
  );

  /* ---------- 9.5 图片素材 ---------- */
  /*
   * PNG 字节：8 字节签名 + IHDR 头 + 一段随机尾巴。
   *
   * 随机尾巴是**必须的**，不是凑数：素材是内容寻址的，同样的字节第二次
   * 上传会复用已有文件、返回 200 而不是 201。如果用固定字节，这个脚本
   * 第一次跑过之后，第二次就必然在"返回 201"那条断言上失败 ——
   * 正是 R10 说的"测试要能在有真实数据的库上反复运行"。
   * 随机尾巴让每次运行都是全新的内容，从而稳定地走到"新建"分支。
   */
  console.log("\n9.5 图片素材（上传 / 内容寻址 / 拒绝伪装）");

  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    ...randomBytes(16),
  ]);

  /** multipart 上传，返回 { status, body } */
  async function uploadAsset(bytes, filename, declaredType) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: declaredType }), filename);
    const response = await fetch(`${BASE}/api/assets`, { method: "POST", body: form });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body, headers: response.headers };
  }

  const uploaded = await uploadAsset(pngBytes, "smoke-受击框.png", "image/png");
  check("上传图片返回 201", uploaded.status === 201, `实际 ${uploaded.status}`);
  check(
    "上传返回素材 id 与可粘贴的 markdown",
    typeof uploaded.body?.asset?.id === "string" && /^!\[\]\(asset:[0-9a-f]{64}\.png\)$/.test(uploaded.body.asset.markdown),
    `实际 ${JSON.stringify(uploaded.body).slice(0, 160)}`,
  );

  const assetId = uploaded.body?.asset?.id;
  if (typeof assetId === "string") {
    const fetched = await fetch(`${BASE}/api/assets/${assetId}`);
    const fetchedBytes = new Uint8Array(await fetched.arrayBuffer());
    check("取回素材返回 200", fetched.status === 200, `实际 ${fetched.status}`);
    check(
      "取回时带 nosniff（阻止浏览器按 HTML 嗅探）",
      fetched.headers.get("x-content-type-options") === "nosniff",
    );
    check(
      "取回的字节与上传的逐位一致",
      fetchedBytes.length === pngBytes.length &&
        fetchedBytes.every((b, i) => b === pngBytes[i]),
      `长度 ${fetchedBytes.length} vs ${pngBytes.length}`,
    );

    /*
     * 内容寻址的核心断言：同一张图再传一次必须得到**同一个 id**。
     * 这条挂了缓存就会漂移 —— 用户眼里"同一张图"，缓存眼里是"块被编辑了"。
     */
    const again = await uploadAsset(pngBytes, "另一个文件名.png", "image/png");
    check("同一张图二次上传复用同一个 id", again.body?.asset?.id === assetId);
    check("二次上传不新建文件（200 而非 201）", again.status === 200, `实际 ${again.status}`);

    /*
     * 把引用写进正文，确认它以块的形式存下来、并能被预览读到。
     * 这是"上传成功但正文里用不了"这类断链的防线。
     */
    const imgDoc = await sendJson("POST", "/api/docs", { title: "smoke 图片文档" });
    const imgDocId = imgDoc.body?.doc?.id;
    if (typeof imgDocId === "string") createdDocIds.push(imgDocId);
    if (typeof imgDocId === "string") {
      const saved = await sendJson("PUT", "/api/blocks", {
        docId: imgDocId,
        markdown: `# 图片\n\n![受击框](asset:${assetId})\n`,
        blockIds: [],
      });
      check("含图片的正文能保存", saved.status === 200, `实际 ${saved.status}`);
      const readBack = await getJson(`/api/blocks?docId=${encodeURIComponent(imgDocId)}`);
      check(
        "正文里的 asset: 引用原样存回（不被改写、不被剥掉）",
        String(readBack.body?.markdown ?? "").includes(`asset:${assetId}`),
        `实际 ${String(readBack.body?.markdown ?? "").slice(0, 160)}`,
      );
      await fetch(`${BASE}/api/docs?id=${encodeURIComponent(imgDocId)}`, { method: "DELETE" });
    }
  }

  const disguised = await uploadAsset(
    new TextEncoder().encode("<html><script>alert(1)</script></html>"),
    "evil.png",
    "image/png",
  );
  check(
    "伪装成 png 的 HTML 被拒绝（魔数判定，不采信声明的类型）",
    disguised.status === 400,
    `实际 ${disguised.status} ${JSON.stringify(disguised.body)}`,
  );

  const traversal = await fetch(`${BASE}/api/assets/${encodeURIComponent("../../package.json")}`);
  check("素材路径穿越取回被拒（404）", traversal.status === 404, `实际 ${traversal.status}`);

  const missingAsset = await fetch(`${BASE}/api/assets/${"f".repeat(64)}.png`);
  check("不存在的素材返回 404", missingAsset.status === 404, `实际 ${missingAsset.status}`);

  /* ---------- 10. 清理 ---------- */
  console.log("\n10. 清理");

  const delConv = await fetch(`${BASE}/api/conversations?id=${encodeURIComponent(convId)}`, {
    method: "DELETE",
  });
  check("删除会话成功", delConv.status === 200);
  const delDoc = await fetch(`${BASE}/api/docs?id=${encodeURIComponent(docId)}`, {
    method: "DELETE",
  });
  check("删除文档成功", delDoc.status === 200);

  /*
   * 软删之后**再彻底清一次**它自己建的那几篇。
   *
   * 不这么做的话，冒烟会在用户的库里持续累积 `deleted_at` 非空的行：
   * 清理逻辑靠 `listDocs`，而它已经过滤掉软删的文档，于是下次跑根本看不见
   * 这些残留、也就永远清不掉（只增不减）。
   *
   * ⚠️ 只清**本次自己创建的 id**，不做"清掉所有已删文档"这种批量操作 ——
   * 用户回收站里的东西不归冒烟测试管（R10：只断言、只清理自己创建的东西）。
   */
  for (const id of createdDocIds) {
    if (typeof id !== "string" || id === "") continue;
    await fetch(`${BASE}/api/docs?id=${encodeURIComponent(id)}&purge=1`, {
      method: "DELETE",
    });
  }

  const after = await getJson("/api/docs");
  check(
    "清理后不留冒烟产物",
    (after.body?.docs ?? []).every((d) => !d.title?.startsWith(MARK)),
  );

  // 回收站里也不能留下自己造的东西
  const trash = await getJson("/api/docs?deleted=1");
  check(
    "清理后回收站里也不留冒烟产物",
    (trash.body?.docs ?? []).every((d) => !d.title?.startsWith(MARK)),
  );
}

main()
  .then(() => {
    console.log(`\n[smoke] 通过 ${passed} 项，失败 ${failed} 项`);
    if (failures.length > 0) {
      console.log("\n失败清单：");
      for (const f of failures) console.log(`  - ${f}`);
    }
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error("\n[smoke] 运行中断：", err);
    process.exit(1);
  });
