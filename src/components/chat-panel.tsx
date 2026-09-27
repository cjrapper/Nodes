"use client";

/**
 * AI 对话面板。
 *
 * 三个与"缓存命中"直接相关的设计决定：
 *  1. **历史消息按原样回放**，不做任何美化或重排 —— L3 层只追加是命中率的基础。
 *  2. **引用块以 chip 形式存在于会话层，而不是把 @[标题] 写进消息正文**。
 *     如果把引用标记混进正文，同一段话在不同引用状态下文本就不同，
 *     历史会永久分叉；放在会话层则 L2 变化不影响 L3 的字节表示。
 *  3. 发请求前后都展示缓存预测/实际值，让"改了引用会多花多少钱"即时可见。
 *     完整的**分层明细**现在住在「缓存」页（通过 onPlanChanged 上报过去），
 *     对话区只保留最需要即时看到的两三个数字，避免挤压聊天空间。
 */

import {
  AtSign,
  ChevronDown,
  CornerDownLeft,
  Loader2,
  Send,
  Sparkles,
  StopCircle,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, cn, formatUsd, streamChat } from "@/lib/ui/client";
import { useRenderWatchdog, useStableCallback } from "@/lib/ui/hooks";
import type {
  ConversationView,
  MessageView,
  ModelView,
  SearchResultView,
  TurnPlanView,
  TurnResultView,
} from "@/lib/ui/types";
import { renderMarkdownToHtml } from "@/lib/render/markdown";

interface ChatPanelProps {
  conversation: ConversationView | null;
  models: ModelView[];
  /** 当前会话已挂载的块（由上层同步，用于编辑器里标记「已挂载」） */
  onRefsChanged: (refBlockIds: string[]) => void;
  onConversationUpdated: () => void;
  /** 本轮结束时把最新的缓存结果上报，供全局状态与仪表盘使用 */
  onTurnComplete?: (result: TurnResultView) => void;
  /**
   * 缓存组装计划更新时上报。
   *
   * 上层把最近一次的 plan 存下来传给「缓存」页 —— 实时分层明细现在住在
   * 那里（对话区保持干净的聊天界面），需要这条通道把数据送过去。
   */
  onPlanChanged?: (plan: TurnPlanView) => void;
  /**
   * 上层塞进来的"立即执行"任务。
   *
   * 模块概览页的 AI 按钮（查漏补缺 / 评判修改 / 自测提问）用它：
   * 用户点一下，就应当看到整个模块被挂载并且问题已经发出去了，
   * 而不是先手动挂载、再自己把提示词敲进输入框。
   *
   * `token` 是单调递增的标识 —— 依赖它而不是依赖整个对象，
   * 可以避免"同样的内容想再跑一次"被判定成没有变化。
   */
  pendingRun?: PendingRun | null;
  onConsumePendingRun?: () => void;
}

export interface PendingRun {
  /** 一次性标识，保证同一内容也能被重复触发 */
  token: number;
  /** 要整体挂载的文档/模块 id */
  docIds: string[];
  /** 自动填入并发送的内容 */
  content: string;
}

interface ConversationDetail {
  conversation: ConversationView;
  messages: MessageView[];
  refBlockIds: string[];
}

/** 把历史里的块引用标记还原成可读文字（用于回放旧消息） */
function cleanDisplayContent(content: string): string {
  return content.replace(/@\[[^\]]+\]/g, "").replace(/[ \t]{2,}/g, " ").trim();
}

function BlockChip({
  label,
  onRemove,
  sublabel,
}: {
  label: string;
  sublabel?: string;
  onRemove?: () => void;
}) {
  return (
    <span className="flex max-w-[220px] items-center gap-1 rounded-md border border-[#3ddc97]/30 bg-[#3ddc97]/10 px-1.5 py-0.5 text-[10px] text-[#3ddc97]">
      <AtSign size={9} className="shrink-0" />
      <span className="truncate" title={sublabel ?? label}>
        {label}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="移除引用"
          className="shrink-0 rounded hover:text-[var(--nodes-ink)]"
        >
          <X size={9} />
        </button>
      )}
    </span>
  );
}

export default function ChatPanel({
  conversation,
  models,
  onRefsChanged,
  onConversationUpdated,
  onTurnComplete,
  onPlanChanged,
  pendingRun,
  onConsumePendingRun,
}: ChatPanelProps) {
  /*
   * 把父组件传下来的回调钉成稳定引用。它们会进 useCallback / useEffect 的
   * 依赖数组，内联箭头函数会让依赖每次渲染都变，进而形成渲染循环。
   */
  const notifyRefsChanged = useStableCallback(onRefsChanged);
  const notifyConversationUpdated = useStableCallback(onConversationUpdated);
  const notifyTurnComplete = useStableCallback(onTurnComplete);
  const notifyPlanChanged = useStableCallback(onPlanChanged);
  const notifyConsumePendingRun = useStableCallback(onConsumePendingRun);

  useRenderWatchdog("ChatPanel");

  const [messages, setMessages] = useState<MessageView[]>([]);
  const [refs, setRefs] = useState<{ blockId: string; label: string; path: string }[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [streamReasoning, setStreamReasoning] = useState("");
  const [showReasoning, setShowReasoning] = useState(false);
  const [plan, setPlan] = useState<TurnPlanView | null>(null);
  const [result, setResult] = useState<TurnResultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 本轮正在执行/已执行的工具。
   *
   * 它存在的唯一理由：AI 现在会**真的改用户的笔记**。
   * 界面上必须能看见"它动了什么"，否则用户只会看到回答里提到一篇
   * 他没写过的文档，然后去怀疑自己的记忆。
   */
  const [runningTools, setRunningTools] = useState<
    { id: string; name: string; status: string; summary: string }[]
  >([]);

  // @ 引用选择器
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerResults, setPickerResults] = useState<SearchResultView[]>([]);
  const [pickerIndex, setPickerIndex] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const conversationId = conversation?.id ?? null;
  const activeModelId = conversation?.modelConfigId ?? models.find((m) => m.isDefault)?.id ?? null;

  /**
   * 所有 plan 更新都必须经过这里，而不是直接 setPlan。
   *
   * 原因：上层（「缓存」页）也需要这份数据，漏掉任何一处 setPlan 就会出现
   * "某条路径下仪表盘显示的是上一轮的构成"。用一个函数收口可以杜绝这种漂移。
   */
  const applyPlan = useCallback(
    (next: TurnPlanView | null) => {
      setPlan(next);
      if (next) notifyPlanChanged(next);
    },
    [notifyPlanChanged],
  );

  /* ---------------- 载入会话内容 ---------------- */

  const load = useCallback(async (id: string) => {
    try {
      const data = await api.get<ConversationDetail>(`/api/messages?id=${encodeURIComponent(id)}`);
      setMessages(data.messages);

      // 引用块只拿到 id，通过 /api/refs 一次性补全可读标签与路径
      if (data.refBlockIds.length > 0) {
        try {
          const detail = await api.post<{
            blocks: {
              blockId: string;
              path: string;
              snippet: string;
              missing: boolean;
            }[];
          }>("/api/refs", { blockIds: data.refBlockIds });
          setRefs(
            detail.blocks
              .filter((b) => !b.missing)
              .map((b) => ({ blockId: b.blockId, label: b.snippet, path: b.path })),
          );
        } catch {
          setRefs(
            data.refBlockIds.map((blockId) => ({
              blockId,
              label: blockId.slice(0, 8),
              path: "",
            })),
          );
        }
      } else {
        setRefs([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载会话失败");
    }
  }, []);

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setRefs([]);
      applyPlan(null);
      setResult(null);
      return;
    }
    applyPlan(null);
    setResult(null);
    setStreamText("");
    void load(conversationId);
  }, [conversationId, load, applyPlan]);

  /* ---------------- 缓存预览（不花钱就能看到影响） ---------------- */

  const refreshPreview = useCallback(
    async (nextRefs?: { blockId: string }[]) => {
      if (!conversationId) return;
      const ids = (nextRefs ?? refs).map((r) => r.blockId);
      try {
        const data = await api.post<{ plan: TurnPlanView }>("/api/preview", {
          conversationId,
          content: input.trim() || "（预览）",
          modelConfigId: activeModelId,
          refBlockIds: ids,
        });
        applyPlan(data.plan);
      } catch {
        // 预览失败不影响主流程，静默处理
      }
    },
    [conversationId, refs, input, activeModelId, applyPlan],
  );

  /**
   * 引用集合变化的唯一出口：同时更新本地 chip 与服务端会话引用。
   *
   * 引用集合决定 L2 层内容，所以每次变化都要同步到服务端 ——
   * 否则下一轮组装会用旧集合，预测与实际对不上。
   */
  const applyRefs = useCallback(
    async (next: { blockId: string; label: string; path: string }[]) => {
      setRefs(next);
      if (!conversationId) return;
      try {
        await api.patch("/api/conversations", {
          id: conversationId,
          refBlockIds: next.map((r) => r.blockId),
        });
        notifyRefsChanged(next.map((r) => r.blockId));
        void refreshPreview(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : "更新引用失败");
      }
    },
    [conversationId, notifyRefsChanged, refreshPreview],
  );

  useEffect(() => {
    if (conversationId && messages.length >= 0) {
      void refreshPreview();
    }
    // 只在会话切换与引用集合变化时刷新，不跟随每次输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, refs.length]);

  /* ---------------- 整体挂载的模块 ---------------- */

  /**
   * 覆盖式设置"整体挂载的模块"。
   *
   * 走服务端而不仅仅是本地状态：模块引用是 L2 模块层的内容来源，
   * 不同步的话组装器拿到的还是旧集合，缓存预测会与实际对不上。
   */
  const applyDocRefs = useCallback(
    async (docIds: readonly string[]) => {
      if (!conversationId) return;
      try {
        await api.patch("/api/conversations", { id: conversationId, refDocIds: [...docIds] });
        // 重新拉一次会话，让挂载状态与服务端保持一致
        await load(conversationId);
        void refreshPreview();
      } catch (err) {
        setError(err instanceof Error ? err.message : "挂载模块失败");
      }
    },
    [conversationId, load, refreshPreview],
  );

  /**
   * 执行一个"待发送"的请求。
   *
   * 这条路是给模块概览页的 AI 按钮用的：用户点「查漏补缺」时，
   * 期望的是"把这个模块交给 AI 并立刻发问"，而不是先挂载、再自己把
   * 提示词打进输入框。所以这里由上层塞进来一段内容 + 一组模块 id，
   * 面板自动完成挂载与发送。
   *
   * 用 ref 拿最新的 send 而不是把它写进依赖：send 每次输入都会重建，
   * 写进依赖会让这个 effect 反复触发、把同一句话发很多遍。
   */
  const sendRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (!pendingRun || !conversationId) return;
    void (async () => {
      await applyDocRefs(pendingRun.docIds);
      setInput(pendingRun.content);
      // 等 setInput 落地再发，否则 send 读到的还是空的 input
      setTimeout(() => void sendRef.current?.(), 50);
      notifyConsumePendingRun();
    })();
    // 只在"有新任务"时触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRun?.token]);

  /* ---------------- @ 选择器 ---------------- */

  useEffect(() => {
    if (!pickerOpen) return;
    const timer = setTimeout(async () => {
      try {
        const data = await api.get<{ results: SearchResultView[] }>(
          `/api/search?q=${encodeURIComponent(pickerQuery)}&limit=24`,
        );
        setPickerResults(data.results);
        setPickerIndex(0);
      } catch {
        setPickerResults([]);
      }
    }, 160);
    return () => clearTimeout(timer);
  }, [pickerOpen, pickerQuery]);

  const addReference = useCallback(
    (item: SearchResultView) => {
      if (refs.some((r) => r.blockId === item.blockId)) {
        setPickerOpen(false);
        return;
      }
      void applyRefs([
        ...refs,
        { blockId: item.blockId, label: item.snippet.slice(0, 24), path: item.path },
      ]);
      setPickerOpen(false);
      setPickerQuery("");
      textareaRef.current?.focus();
    },
    [refs, applyRefs],
  );

  /* ---------------- 发送 ---------------- */

  const send = useCallback(async () => {
    if (!conversationId || streaming) return;
    const content = input.trim();
    if (!content) return;

    setError(null);
    setInput("");
    setStreamText("");
    setStreamReasoning("");
    setResult(null);
    setStreaming(true);

    // 立刻把用户消息插到列表里，不等服务端回包
    const optimistic: MessageView = {
      id: `local_${Date.now()}`,
      conversationId,
      role: "user",
      content,
      refBlockIds: refs.map((r) => r.blockId),
      seq: messages.length,
      createdAt: Date.now(),
    };
    setMessages((prev) => [...prev, optimistic]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      for await (const event of streamChat(
        {
          conversationId,
          content,
          modelConfigId: activeModelId,
          refBlockIds: refs.map((r) => r.blockId),
        },
        controller.signal,
      )) {
        switch (event.type) {
          case "plan":
            applyPlan(event.plan);
            break;
          case "text":
            setStreamText((prev) => prev + event.delta);
            break;
          case "reasoning":
            setStreamReasoning((prev) => prev + event.delta);
            break;
          case "notice":
            setPlan((prev) =>
              prev ? { ...prev, warnings: [...prev.warnings, event.message] } : prev,
            );
            break;
          /*
           * 工具事件必须显式处理。
           *
           * 这个 switch 没有 default，所以漏掉一种事件的结果是
           * "工具在后台真的改了用户的笔记，而界面上一个字都没有" ——
           * 用户会以为 AI 只是没回答，而实际上库里已经多了东西。
           */
          case "tool_start":
            setRunningTools((prev) => [
              ...prev,
              { id: event.id, name: event.name, status: "running", summary: "" },
            ]);
            break;
          case "tool_result":
            setRunningTools((prev) =>
              prev.map((tool) =>
                tool.id === event.id
                  ? { ...tool, status: event.isError ? "error" : "ok", summary: event.summary }
                  : tool,
              ),
            );
            break;
          case "final":
            setResult(event.result);
            notifyTurnComplete(event.result);
            break;
          case "error":
            setError(event.message);
            break;
          case "start":
            break;
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : "请求失败");
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      // 重新拉一次消息，拿到服务端生成的真实消息 id 与顺序
      await load(conversationId);
      notifyConversationUpdated();
      setStreamText("");
      setStreamReasoning("");
      setRunningTools([]);
    }
  }, [
    conversationId,
    streaming,
    input,
    refs,
    messages.length,
    activeModelId,
    load,
    notifyConversationUpdated,
    notifyTurnComplete,
    applyPlan,
  ]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  /*
   * 把最新的 send 挂到 ref 上，供"立即执行"那条路径调用。
   *
   * 赋值放在渲染期（而不是 effect 里）：pendingRun 的 effect 会在
   * 提交后立刻读它，晚一帧就会拿到上次的闭包。
   */
  sendRef.current = send;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamText]);

  const visibleMessages = useMemo(
    () => messages.filter((m) => m.role !== "system"),
    [messages],
  );

  /** 上下文占用比例，用于顶部小提示 */
  const contextUsage = plan ? plan.totalTokens / plan.contextWindow : 0;

  if (!conversation) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-[#0b0d10]">
        <div className="max-w-sm text-center">
          <Sparkles size={20} className="mx-auto mb-2 text-[#3ddc97]" />
          <p className="text-[13px] text-[var(--nodes-ink-dim)]">还没有对话</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--nodes-ink-faint)]">
            在左侧新建一个对话，然后用 @ 挂载知识块。挂载的块会稳定地进入上下文，
            在后续每一轮里以约 1/10 的价格被复用。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-[#0b0d10]">
      {/* 顶部只剩会话标题与两个关键数字 —— 
          模型选择、缓存明细都下移到输入框附近，因为那些是"发消息时"才关心的东西 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[#23282f] px-3 py-2">
        <span className="truncate text-[12px] font-medium text-[var(--nodes-ink)]">
          {conversation.title}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2 text-[10px]">
          {plan && (
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 font-mono",
                contextUsage > 0.85
                  ? "bg-[#f2555a]/15 text-[#f2555a]"
                  : contextUsage > 0.6
                    ? "bg-[#f5b544]/15 text-[#f5b544]"
                    : "bg-[#171b21] text-[var(--nodes-ink-faint)]",
              )}
              title={`本轮输入约 ${plan.totalTokens} token，模型窗口 ${plan.contextWindow}`}
            >
              上下文 {(contextUsage * 100).toFixed(0)}%
            </span>
          )}
          {result && (
            <span className="rounded-full bg-[#3ddc97]/12 px-1.5 py-0.5 font-mono text-[#3ddc97]">
              命中 {(result.cost.hitRate * 100).toFixed(0)}%
            </span>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* 消息区 */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {visibleMessages.length === 0 && !streaming && (
            <p className="py-6 text-center text-[12px] text-[var(--nodes-ink-faint)]">
              用 @ 挂载知识块，然后提问。例如：「把挂载的几段整理成一份发布检查清单」。
            </p>
          )}

          <div className="space-y-3">
            {visibleMessages.map((m) => (
              <div key={m.id} className="group">
                <div className="mb-1 flex items-center gap-2 text-[10px] text-[var(--nodes-ink-faint)]">
                  <span
                    className={cn(
                      "font-medium",
                      m.role === "user" ? "text-[var(--nodes-ink-dim)]" : "text-[#3ddc97]",
                    )}
                  >
                    {m.role === "user" ? "你" : "AI"}
                  </span>
                  {m.refBlockIds.length > 0 && (
                    <span className="flex items-center gap-1 text-[#3ddc97]/70">
                      <AtSign size={9} />
                      {m.refBlockIds.length} 个块
                    </span>
                  )}
                </div>
                {m.role === "assistant" ? (
                  <div
                    className="nodes-md text-[#d5dbe3]"
                    dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(m.content) }}
                  />
                ) : (
                  <p className="text-[13px] leading-[1.75] whitespace-pre-wrap text-[var(--nodes-ink)]">
                    {cleanDisplayContent(m.content)}
                  </p>
                )}
              </div>
            ))}

            {streaming && (
              <div>
                <div className="mb-1 flex items-center gap-2 text-[10px]">
                  <span className="font-medium text-[#3ddc97]">AI</span>
                  {streamReasoning && (
                    <button
                      type="button"
                      onClick={() => setShowReasoning((v) => !v)}
                      className="flex items-center gap-0.5 text-[var(--nodes-ink-faint)] hover:text-[var(--nodes-ink-dim)]"
                    >
                      <ChevronDown
                        size={10}
                        className={cn("transition-transform", !showReasoning && "-rotate-90")}
                      />
                      思维链
                    </button>
                  )}
                </div>
                {showReasoning && streamReasoning && (
                  <pre className="mb-2 max-h-48 overflow-y-auto rounded-md bg-[#12151a] p-2 text-[11px] whitespace-pre-wrap text-[var(--nodes-ink-faint)]">
                    {streamReasoning}
                  </pre>
                )}
                {/*
                  工具活动条。
                  AI 会真的改用户的笔记，所以"它动了什么"必须看得见 ——
                  否则用户只会在回答里看到一篇自己没写过的文档，然后怀疑记忆。
                  运行中显示工具名 + 转圈，完成后显示结果摘要；失败的用红色标出来
                  （失败也是要让人知道的事，不是可以吞掉的细节）。
                */}
                {runningTools.length > 0 && (
                  <ul className="mb-2 flex flex-col gap-1">
                    {runningTools.map((tool) => (
                      <li
                        key={tool.id}
                        className={cn(
                          "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]",
                          tool.status === "running" &&
                            "border-[#23282f] bg-[#12151a] text-[var(--nodes-ink-dim)]",
                          tool.status === "ok" &&
                            "border-[#3ddc97]/40 bg-[#3ddc97]/10 text-[#3ddc97]",
                          tool.status === "error" &&
                            "border-[#f2555a]/40 bg-[#f2555a]/10 text-[#f2555a]",
                        )}
                      >
                        {tool.status === "running" ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <Wrench size={11} />
                        )}
                        <span className="font-mono">{tool.name}</span>
                        {tool.summary ? <span>· {tool.summary}</span> : null}
                        {tool.status === "running" ? <span>· 执行中…</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
                <div
                  className="nodes-md nodes-caret text-[#d5dbe3]"
                  dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(streamText) }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 输入区 */}
      <div className="shrink-0 border-t border-[#23282f] p-2.5">
        {/* 引用 chips */}
        {refs.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {refs.map((r) => (
              <BlockChip
                key={r.blockId}
                label={r.label || r.blockId.slice(0, 8)}
                sublabel={r.path}
                onRemove={() => void applyRefs(refs.filter((x) => x.blockId !== r.blockId))}
              />
            ))}
            <span className="self-center text-[10px] text-[var(--nodes-ink-faint)]">
              共 {refs.length} 块挂载在 L2 层
            </span>
          </div>
        )}

        {error && (
          <div className="mb-2 rounded-md bg-[#f2555a]/10 px-2 py-1.5 text-[11px] text-[#f2555a]">
            {error}
          </div>
        )}

        <div className="relative rounded-xl border border-[#23282f] bg-[#12151a] focus-within:border-[#3ddc97]/50">
          {pickerOpen && (
            <div className="absolute bottom-full left-0 z-20 mb-2 max-h-72 w-full overflow-y-auto rounded-xl border border-[#23282f] bg-[#171b21] shadow-2xl">
              <div className="sticky top-0 border-b border-[#23282f] bg-[#171b21] p-2">
                <input
                  autoFocus
                  value={pickerQuery}
                  onChange={(e) => setPickerQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setPickerIndex((i) => Math.min(i + 1, pickerResults.length - 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setPickerIndex((i) => Math.max(i - 1, 0));
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      const item = pickerResults[pickerIndex];
                      if (item) addReference(item);
                    } else if (e.key === "Escape") {
                      setPickerOpen(false);
                    }
                  }}
                  placeholder="搜索知识块标题或内容…"
                  aria-label="搜索知识块"
                  className="w-full bg-transparent text-[12px] text-[var(--nodes-ink)] placeholder:text-[var(--nodes-ink-faint)]"
                />
              </div>
              {pickerResults.length === 0 ? (
                <p className="p-3 text-[11px] text-[var(--nodes-ink-faint)]">
                  {pickerQuery ? "没有找到匹配的块" : "输入关键词搜索，或先写点内容"}
                </p>
              ) : (
                pickerResults.map((item, i) => {
                  const already = refs.some((r) => r.blockId === item.blockId);
                  return (
                    <button
                      key={item.blockId}
                      type="button"
                      onMouseEnter={() => setPickerIndex(i)}
                      onClick={() => addReference(item)}
                      className={cn(
                        "flex w-full flex-col gap-0.5 border-b border-[#23282f]/60 px-3 py-2 text-left last:border-0",
                        i === pickerIndex && "bg-[#23282f]",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[11px] text-[var(--nodes-ink-dim)]">{item.path}</span>
                        <span className="shrink-0 font-mono text-[9px] text-[var(--nodes-ink-faint)]">
                          #{item.cacheKey.slice(0, 8)}
                        </span>
                        {already && (
                          <span className="ml-auto shrink-0 text-[9px] text-[#3ddc97]">已挂载</span>
                        )}
                      </div>
                      <span className="line-clamp-2 text-[11px] text-[var(--nodes-ink)]">
                        {item.snippet}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !pickerOpen) {
                e.preventDefault();
                void send();
                return;
              }
              /*
               * 输入 @ 直接唤起知识块选择器 —— 这是本应用的主交互，
               * 不该藏在按钮里。选择器里的查询词独立维护（pickerQuery），
               * 所以这里不必从文本里解析 @ 后面的内容。
               */
              if (e.key === "@" && !pickerOpen) {
                setPickerOpen(true);
                setPickerQuery("");
              }
            }}
            rows={3}
            aria-label="输入消息"
            placeholder="提问，或输入 @ 挂载知识块…（Enter 发送，Shift+Enter 换行）"
            className="w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-[var(--nodes-ink)] placeholder:text-[var(--nodes-ink-faint)]"
          />

          <div className="flex items-center gap-1.5 px-2 pb-2">
            <button
              type="button"
              onClick={() => {
                setPickerOpen((v) => !v);
                setPickerQuery("");
              }}
              className="flex shrink-0 items-center gap-1 rounded-md bg-[#171b21] px-2 py-1 text-[11px] text-[var(--nodes-ink-dim)] transition-colors hover:text-[#3ddc97]"
            >
              <AtSign size={11} />
              引用知识块
            </button>

            {/*
              模型选择放在这里而不是顶栏：它是"发这条消息时"才需要决定的参数，
              跟发送按钮是一组动作。放到画布顶部会让人以为它是全局设置。
              跟主流 agent 客户端的习惯一致。
            */}
            <select
              aria-label="选择模型"
              value={activeModelId ?? ""}
              onChange={async (e) => {
                const next = e.target.value || null;
                await api.patch("/api/conversations", {
                  id: conversation.id,
                  modelConfigId: next,
                });
                notifyConversationUpdated();
                // 换模型必然让服务商侧缓存全部失效，立刻刷新预测让用户看到代价
                setTimeout(() => void refreshPreview(), 60);
              }}
              title="切换模型会让服务商侧缓存失效一次"
              className="min-w-0 max-w-[150px] shrink rounded-md border border-[#23282f] bg-[#171b21] px-1.5 py-1 text-[11px] text-[var(--nodes-ink-dim)]"
            >
              {models.length === 0 && <option value="">（未配置模型）</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.apiKeySet ? "" : "（未填 Key）"}
                </option>
              ))}
            </select>

            {/* 本轮结果摘要：完整分层明细在「缓存」页，这里只留最关心的两个数 */}
            {result && (
              <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
                <span className="text-[#3ddc97]">省 {formatUsd(result.cost.savedUsd)}</span>
                <span className="text-[var(--nodes-ink-faint)]">·</span>
                <span className="text-[var(--nodes-ink-dim)]">{(result.latencyMs / 1000).toFixed(1)}s</span>
              </span>
            )}

            {!result && (
              <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-[var(--nodes-ink-faint)]">
                <CornerDownLeft size={10} />
                发送
              </span>
            )}

            {streaming ? (
              <button
                type="button"
                onClick={stop}
                className="flex shrink-0 items-center gap-1 rounded-md bg-[#f2555a]/15 px-2.5 py-1 text-[11px] text-[#f2555a] transition-colors hover:bg-[#f2555a]/25"
              >
                <StopCircle size={11} />
                停止
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void send()}
                disabled={!input.trim()}
                className="flex shrink-0 items-center gap-1 rounded-md bg-[#3ddc97]/15 px-2.5 py-1 text-[11px] text-[#3ddc97] transition-colors hover:bg-[#3ddc97]/25 disabled:opacity-40"
              >
                <Send size={11} />
                发送
              </button>
            )}
          </div>
        </div>

        {/* 缓存提示：只在"这一轮会吃亏"的时候出现，平时不占地方 */}
        {plan && plan.invalidation.reason !== "none" && (
          <p className="mt-1.5 truncate px-1 text-[10px] leading-relaxed text-[var(--nodes-ink-faint)]">
            {plan.invalidation.detail}
          </p>
        )}
      </div>
    </div>
  );
}
