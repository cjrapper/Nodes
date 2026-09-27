"use client";

/**
 * 工作区外壳：组装侧栏、编辑器、对话面板与各类弹窗，持有全局状态。
 *
 * 状态管理的取舍：全部用 useState 提在这里，不引入状态库。
 * 原因是需要跨组件共享的状态其实很少（文档树、会话列表、当前选中项、
 * 待引用的块），而**缓存相关的状态刻意不共享** —— 它属于"某一轮对话"，
 * 由 chat-panel 自己持有，避免出现"上一轮的命中率显示在下一轮旁边"的串味。
 *
 * 布局全部可拖拽（见 split.tsx）。尺寸通过 localStorage 记忆，
 * 因为"我费劲调好的宽度刷新一下就没了"是很糟的体验。
 */

import { AlertTriangle, Check, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import CacheDashboard from "@/components/cache-dashboard";
import ChatPanel, { type PendingRun } from "@/components/chat-panel";
import EditorPanel from "@/components/editor-panel";
import ModelsPanel from "@/components/models-panel";
import ModuleOverview from "@/components/module-overview";
import SettingsModal from "@/components/settings-modal";
import Sidebar from "@/components/sidebar";
import { Divider, useResizableSize } from "@/components/split";
import { api, cn } from "@/lib/ui/client";
import { useRenderWatchdog } from "@/lib/ui/hooks";
import { DOC_QUERY_PARAM, docIdFromHref } from "@/lib/ui/diagram-links";
import { DEFAULT_APPEARANCE } from "@/lib/db/types";
import type {
  ConversationView,
  DocTreeNode,
  DocView,
  ModelView,
  TurnPlanView,
  TurnResultView,
  WorkspaceView,
} from "@/lib/ui/types";

interface Toast {
  id: number;
  tone: "info" | "warn" | "error" | "ok";
  message: string;
}

/** 把扁平的文档列表拼成树 */
function buildTree(docs: DocView[]): DocTreeNode[] {
  const nodes = new Map<string, DocTreeNode>();
  for (const d of docs) nodes.set(d.id, { ...d, children: [] });
  const roots: DocTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (list: DocTreeNode[]) => {
    list.sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

export default function WorkspaceShell() {
  // 开发期看门狗：一旦渲染次数异常，控制台会直接点名到组件
  useRenderWatchdog("WorkspaceShell");

  /* ---------------- 面板尺寸（拖拽 + 记忆） ---------------- */
  const [sidebarWidth, setSidebarWidth] = useResizableSize("sidebar", 264, 180, 520);
  const [chatWidth, setChatWidth] = useResizableSize("chat", 460, 300, 900);
  const [showCache, setShowCache] = useState(false);

  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [docs, setDocs] = useState<DocView[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  /**
   * 每个文档的"总块数 / 被 AI 看过的块数"。模块概览页用它算覆盖度 ——
   * 只有进过上下文的内容才可能被挑错或出题，所以这个比例衡量的是
   * "这个方向有多少内容被检验过"，而不是"写了多少"。
   */
  const [coverage, setCoverage] = useState<
    Record<string, { blockCount: number; referencedBlockCount: number }>
  >({});
  const [conversations, setConversations] = useState<ConversationView[]>([]);
  const [models, setModels] = useState<ModelView[]>([]);

  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);

  const [referencedBlockIds, setReferencedBlockIds] = useState<string[]>([]);

  /*
   * 最近一轮的缓存组装计划与结算结果。
   *
   * 由对话面板通过回调上报，再传给「缓存」页 —— 实时分层明细住在那边。
   * 这两个值刻意**不参与任何业务逻辑**，只是"从对话搬运到仪表盘"，
   * 所以放在外壳这一层是合适的；一旦它开始影响别的东西，就该考虑换个位置。
   */
  const [livePlan, setLivePlan] = useState<TurnPlanView | null>(null);
  const [liveResult, setLiveResult] = useState<TurnResultView | null>(null);

  /**
   * 待执行的 AI 任务（模块概览页的三个动作塞进来的）。
   * `token` 保证同一内容也能被再次触发。
   */
  const [pendingRun, setPendingRun] = useState<PendingRun | null>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [showModels, setShowModels] = useState(false);

  const [bootError, setBootError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pushToast = useCallback((tone: Toast["tone"], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, tone, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 6000);
  }, []);

  /* ---------------- 数据加载 ---------------- */

  const refreshDocs = useCallback(async () => {
    const data = await api.get<{
      docs: DocView[];
      counts: Record<string, number>;
      coverage: Record<string, { blockCount: number; referencedBlockCount: number }>;
    }>("/api/docs");
    setDocs(data.docs);
    setCounts(data.counts);
    setCoverage(data.coverage ?? {});
    return data.docs;
  }, []);

  const refreshConversations = useCallback(async () => {
    const data = await api.get<{ conversations: ConversationView[] }>("/api/conversations");
    setConversations(data.conversations);
    return data.conversations;
  }, []);

  const refreshModels = useCallback(async () => {
    const data = await api.get<{ models: ModelView[] }>("/api/models");
    setModels(data.models);
    return data.models;
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [wsData, docList, convList, modelList] = await Promise.all([
          api.get<{ workspace: WorkspaceView }>("/api/workspace"),
          refreshDocs(),
          refreshConversations(),
          refreshModels(),
        ]);
        setWorkspace(wsData.workspace);

        /*
         * 初始选中的文档优先取 URL 里的 `?doc=<id>`。
         *
         * 这个参数是图表节点链接的落点（见 lib/ui/diagram-links.ts），
         * 所以刷新页面、把链接发给别人、中键新窗口打开都能落在同一篇文档上。
         * 只有在参数缺失或指向已删除的文档时才回退到第一篇。
         */
        const requested = new URLSearchParams(window.location.search).get(DOC_QUERY_PARAM);
        const target = requested && docList.some((d) => d.id === requested) ? requested : null;
        if (requested && !target) {
          pushToast("info", "链接指向的文档不存在，已打开第一篇文档");
        }
        setActiveDocId(target ?? docList[0]?.id ?? null);
        setActiveConversationId(convList[0]?.id ?? null);
      } catch (err) {
        setBootError(err instanceof Error ? err.message : "初始化失败");
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshDocs, refreshConversations, refreshModels, pushToast]);

  /**
   * 打开一篇文档（并同步 URL）。
   *
   * `?doc=<id>` 是图表节点链接与"把链接发给别人"的落点，所以**每一次**
   * 切换文档都要把它写回 URL。反过来，popstate（浏览器前进/后退）与
   * 首次加载都要读它。三条路径都收敛到这一个函数，避免出现
   * "点图上的节点能跳、点左边的树不能"这类不一致。
   */
  const openDoc = useCallback((docId: string) => {
    setActiveDocId(docId);
    setShowCache(false);
    const nextUrl = `?${DOC_QUERY_PARAM}=${encodeURIComponent(docId)}`;
    if (window.location.search !== nextUrl) {
      window.history.pushState(null, "", nextUrl);
    }
  }, []);

  /**
   * 图表节点点击后的导航。
   *
   * 图里的链接是 `?doc=<id>`（由渲染器输出成真正的 `<a href>`），
   * 浏览器会按普通同源导航处理 —— 也就是**整页刷新**。对本地应用来说
   * 刷新一下能接受，但"点个节点就白屏一下"体验很差。
   *
   * 这里用事件委托拦下文档链接；用委托而不是给每个 `<a>` 绑 onClick，
   * 是因为图表的 SVG 是纯函数渲染出的字符串，注入后 React 管不到里面的元素。
   */
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      // 只接管左键单击，其余（中键、Ctrl+点击）交给浏览器原生行为
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as HTMLElement | null)?.closest?.("a");
      if (!anchor) return;

      const docId = docIdFromHref(anchor.getAttribute("href") ?? "");
      if (!docId) return;

      event.preventDefault();
      openDoc(docId);
    };

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [openDoc]);

  /** 浏览器前进/后退时同步选中项 */
  useEffect(() => {
    const onPopState = () => {
      const requested = new URLSearchParams(window.location.search).get(DOC_QUERY_PARAM);
      if (requested) setActiveDocId(requested);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  /* ---------------- 文档操作 ---------------- */

  const createDoc = useCallback(
    async (parentId: string | null) => {
      try {
        // 标题留空而不是给"未命名文档"：三篇同名文档在树里根本分不清谁是谁，
        // 而空标题在树里会显示成弱化的占位提示，一眼就知道还没命名。
        const data = await api.post<{ doc: DocView }>("/api/docs", {
          parentId,
          title: "",
        });
        await refreshDocs();
        setActiveDocId(data.doc.id);
        setShowCache(false);
        return data.doc.id;
      } catch (err) {
        pushToast("error", err instanceof Error ? err.message : "新建文档失败");
        return null;
      }
    },
    [refreshDocs, pushToast],
  );

  /**
   * 重命名文档。
   *
   * 刻意**不经过编辑器**：文档树里的就地改名、编辑器顶部的标题框、
   * 以及未来任何入口都应该走同一条路径，否则很容易出现"某个入口改了
   * 另一个地方不更新"的不一致。改完刷新列表让所有位置同步。
   */
  const renameDoc = useCallback(
    async (docId: string, title: string) => {
      try {
        await api.patch("/api/docs", { id: docId, title });
        await refreshDocs();
      } catch (err) {
        pushToast("error", err instanceof Error ? err.message : "重命名失败");
      }
    },
    [refreshDocs, pushToast],
  );

  /**
   * 新建模块容器。
   *
   * 与新建文档分开，因为语义完全不同：模块不写正文，只是分类节点。
   * 用户明确要这种"空组件"—— 分类本身就是知识结构的一部分，
   * 而且它是 AI「查漏补缺」的天然作用单位。
   */
  /**
   * 在「普通文档」与「模块容器」之间互转。
   *
   * 用户往往是先建了一堆普通文档，后来才意识到某个方向应该是个分类容器。
   * 没有这个入口就只能删了重建，把内容一起丢掉。
   */
  const setDocKind = useCallback(
    async (docId: string, kind: "doc" | "module") => {
      try {
        await api.patch("/api/docs", { id: docId, kind });
        await refreshDocs();
        pushToast(
          "info",
          kind === "module"
            ? "已转为模块容器：它不再显示编辑器，改为展示下级知识点概览。"
            : "已转为普通文档：可以写正文了。",
        );
      } catch (err) {
        pushToast("error", err instanceof Error ? err.message : "转换失败");
      }
    },
    [refreshDocs, pushToast],
  );

  const createModule = useCallback(    async (parentId: string | null) => {
      try {
        const data = await api.post<{ doc: DocView }>("/api/docs", {
          parentId,
          title: "",
          kind: "module",
        });
        await refreshDocs();
        setActiveDocId(data.doc.id);
        setShowCache(false);
        return data.doc.id;
      } catch (err) {
        pushToast("error", err instanceof Error ? err.message : "新建模块失败");
        return null;
      }
    },
    [refreshDocs, pushToast],
  );

  const deleteDoc = useCallback(
    async (docId: string) => {
      if (!window.confirm("删除这篇文档及其所有子文档？引用了其中知识块的会话会失去这些引用。")) {
        return;
      }
      try {
        const data = await api.del<{ deleted: string[] }>(`/api/docs?id=${encodeURIComponent(docId)}`);
        const nextDocs = await refreshDocs();
        if (activeDocId && data.deleted.includes(activeDocId)) {
          setActiveDocId(nextDocs[0]?.id ?? null);
        }
        pushToast("info", `已删除 ${data.deleted.length} 篇文档`);
      } catch (err) {
        pushToast("error", err instanceof Error ? err.message : "删除失败");
      }
    },
    [refreshDocs, activeDocId, pushToast],
  );

  /* ---------------- 会话操作 ---------------- */

  const createConversation = useCallback(
    async (refBlockIds?: string[]) => {
      try {
        const data = await api.post<{ conversation: ConversationView }>("/api/conversations", {
          modelConfigId: models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? null,
          refBlockIds,
        });
        await refreshConversations();
        setActiveConversationId(data.conversation.id);
        setShowCache(false);
        return data.conversation.id;
      } catch (err) {
        pushToast("error", err instanceof Error ? err.message : "新建对话失败");
        return null;
      }
    },
    [models, refreshConversations, pushToast],
  );

  const deleteConversation = useCallback(
    async (conversationId: string) => {
      if (!window.confirm("删除这个对话及其全部消息与调用记录？")) return;
      try {
        await api.del(`/api/conversations?id=${encodeURIComponent(conversationId)}`);
        const next = await refreshConversations();
        if (activeConversationId === conversationId) {
          setActiveConversationId(next[0]?.id ?? null);
        }
      } catch (err) {
        pushToast("error", err instanceof Error ? err.message : "删除失败");
      }
    },
    [refreshConversations, activeConversationId, pushToast],
  );

  /* ---------------- 引用流转 ---------------- */

  /**
   * 编辑器点「引用」：若无当前会话，先自动建一个并把块带过去。
   * 这一步让"写文档 → 问 AI"不需要先手动新建对话，减少一次心智跳转。
   *
   * 实现上刻意**直接写服务端**而不是把块塞进一个跨面板的待处理队列：
   * 队列方案在笔记视图里有编辑器和对话面板两个消费者，两边都会去 PATCH
   * 同一批块，引用集合会来回抖动。以服务端当前集合为准做并集，简单且不会丢。
   */
  const handleReference = useCallback(
    async (blockId: string) => {
      if (!activeConversationId) {
        const id = await createConversation([blockId]);
        if (id) {
          setReferencedBlockIds([blockId]);
          pushToast("ok", "已新建对话并挂载该知识块");
        }
        return;
      }
      try {
        const current = await api.get<{ refBlockIds: string[] }>(
          `/api/messages?id=${encodeURIComponent(activeConversationId)}`,
        );
        if (current.refBlockIds.includes(blockId)) {
          pushToast("info", "这个知识块已经挂在当前对话里了");
          return;
        }
        const next = [...current.refBlockIds, blockId];
        await api.patch("/api/conversations", {
          id: activeConversationId,
          refBlockIds: next,
        });
        setReferencedBlockIds(next);
        pushToast(
          "info",
          `已挂载该知识块。L2 层引用集合发生变化，本会话下一轮会重建 L2 缓存（L0/L1 仍可命中）。`,
        );
      } catch (err) {
        pushToast("error", err instanceof Error ? err.message : "挂载失败");
      }
    },
    [activeConversationId, createConversation, pushToast],
  );

  /* ---------------- 传给子组件的稳定回调 ---------------- */

  /*
   * 这些回调必须是**引用恒定**的。它们会被子组件写进 useCallback / useEffect
   * 的依赖数组，如果每次父渲染都产生新引用，就会形成渲染循环
   * （症状：文档列表疯狂闪烁 + 终端被同一个请求刷屏）。
   * 除了包 useCallback，子组件那一侧也用了 useStableCallback 双保险。
   */
  const handleConversationsChanged = useCallback(() => {
    void refreshConversations();
  }, [refreshConversations]);

  const handleRefsChanged = useCallback((next: string[]) => {
    // 逐个比较，内容相同就不 setState —— 无意义的重渲染是渲染循环的燃料
    setReferencedBlockIds((prev) => {
      if (prev.length === next.length && prev.every((id, i) => id === next[i])) return prev;
      return next;
    });
  }, []);

  /** 对话面板上报的实时缓存计划 */
  const handlePlanChanged = useCallback((next: TurnPlanView) => {
    setLivePlan(next);
  }, []);

  /** 本轮结算结果（实际 usage 与花费） */
  const handleTurnComplete = useCallback(
    (next: TurnResultView) => {
      setLiveResult(next);
      // 会话列表里的命中率摘要需要跟着更新
      void refreshConversations();
    },
    [refreshConversations],
  );

  const handleDocLoaded = useCallback((doc: DocView) => {    setDocs((prev) => {
      const index = prev.findIndex((d) => d.id === doc.id);
      if (index === -1) return prev;
      const current = prev[index];
      // 只在标题/图标/父级真的变了才更新，避免"加载完回传"造成一轮空重渲染
      if (
        current.title === doc.title &&
        current.icon === doc.icon &&
        current.parentId === doc.parentId
      ) {
        return prev;
      }
      const next = [...prev];
      next[index] = doc;
      return next;
    });
  }, []);

  /* ---------------- 模块视图 ---------------- */

  const activeDoc = useMemo(
    () => docs.find((d) => d.id === activeDocId) ?? null,
    [docs, activeDocId],
  );

  /** 模块的直接子文档（供概览页列表） */
  const moduleChildren = useMemo(() => {
    if (activeDoc?.kind !== "module") return [];
    return docs
      .filter((d) => d.parentId === activeDoc.id)
      .map((d) => {
        const cov = coverage[d.id];
        return {
          id: d.id,
          title: d.title || (d.kind === "module" ? "未命名模块" : "未命名文档"),
          blockCount: cov?.blockCount ?? counts[d.id] ?? 0,
          /*
           * 真实统计，不是 0。
           *
           * 这里曾经硬编码成 0，后果是覆盖度永远显示 0%、并且一直提示
           * "还没交给 AI 看过" —— 即使用户刚刚用「查漏补缺」看过整个模块。
           * 一个恒为 0 的指标比没有指标更糟：它会让人以为功能坏了。
           */
          referencedBlockCount: cov?.referencedBlockCount ?? 0,
          updatedAt: d.updatedAt,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [activeDoc, docs, counts, coverage]);

  const moduleSubCount = useMemo(() => {
    if (activeDoc?.kind !== "module") return 0;
    return docs.filter((d) => d.parentId === activeDoc.id && d.kind === "module").length;
  }, [activeDoc, docs]);

  /**
   * 模块概览页的 AI 动作。
   *
   * 点一下就要"挂载整个模块 + 把问题发出去"，所以这里把任务交给对话面板，
   * 由它依次完成：设置 refDocIds → 填入内容 → 发送。
   * 之所以不在这里直接调 chat 接口：对话面板持有流式渲染、缓存预测、
   * 消息列表这些状态，绕过它会把同一条链路实现两遍。
   */
  const handleRunAiAction = useCallback(
    async (action: string, prompt: string) => {
      if (!activeDocId) return;
      setPendingRun({
        token: Date.now(),
        docIds: [activeDocId],
        content: prompt,
      });
      void action;
    },
    [activeDocId],
  );

  const handleConsumePendingRun = useCallback(() => setPendingRun(null), []);

  /* ---------------- 编辑器保存后的缓存影响提示 ---------------- */

  const handleSaved = useCallback(
    (impact: {
      changedBlockCount: number;
      affectedBlockCount: number;
      totalAffectedRefs: number;
      hasImpact: boolean;
    }) => {
      if (!impact.hasImpact) return;
      pushToast(
        "warn",
        `本次改动更新了 ${impact.changedBlockCount} 个块，其中 ${impact.affectedBlockCount} 个正被 ${impact.totalAffectedRefs} 处会话引用 —— 这些会话的 L2 层缓存会重建，L0/L1 仍可命中。`,
      );
    },
    [pushToast],
  );

  const docTree = useMemo(() => buildTree(docs), [docs]);
  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId],
  );

  // 外观可能来自旧库（缺少该列）或用户手改坏了 JSON，parseAppearance 会兜底
  const appearance = workspace?.appearance ?? DEFAULT_APPEARANCE;

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0b0d10]">
        <div className="flex items-center gap-2 text-[12px] text-[var(--nodes-ink-faint)]">
          <Loader2 size={14} className="animate-spin" />
          正在初始化工作区…
        </div>
      </div>
    );
  }

  if (bootError || !workspace) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0b0d10]">
        <div className="max-w-md rounded-xl border border-[#f2555a]/30 bg-[#12151a] p-5">
          <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-[#f2555a]">
            <AlertTriangle size={14} />
            初始化失败
          </div>
          <p className="text-[11px] leading-relaxed text-[var(--nodes-ink-dim)]">{bootError}</p>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--nodes-ink-faint)]">
            数据库文件在项目根目录的 <code className="font-mono">.data/nodes.db</code>。
            若首次启动失败，请确认该目录可写。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-screen overflow-hidden"
      /*
       * 外观设置在这里落到根元素上，且只落成 CSS 变量。
       *
       * 好处是"可调外观"与"组件实现"彻底解耦：组件里写的是
       * bg-[var(--nodes-panel)] 这类引用，不需要知道值从哪来，
       * 也不需要为了改一个颜色而重新渲染整棵树。
       * 背景色单独写 inline style，因为它必须覆盖 body 的底色。
       */
      style={
        {
          "--nodes-font-size": `${appearance.fontSize}px`,
          "--nodes-code-size": `${appearance.codeFontSize}px`,
          "--nodes-line-height": String(appearance.lineHeight),
          "--nodes-font-family": appearance.fontFamily || DEFAULT_APPEARANCE.fontFamily,
          "--nodes-accent": appearance.accent,
          "--nodes-canvas": appearance.canvas,
          "--nodes-panel": appearance.panel,
          // 文字三层次。组件里写的是 text-[var(--nodes-ink-dim)] 这类引用，
          // 所以改这三个值就等于改了全站的文字配色，不需要动任何组件。
          "--nodes-ink": appearance.ink,
          "--nodes-ink-dim": appearance.inkDim,
          "--nodes-ink-faint": appearance.inkFaint,
          background: "var(--nodes-canvas)",
          color: "var(--nodes-ink)",
        } as React.CSSProperties
      }
    >
      <Sidebar
        docs={docTree}
        counts={counts}
        activeDocId={activeDocId}
        conversations={conversations}
        activeConversationId={activeConversationId}
        cacheOpen={showCache}
        onToggleCache={() => setShowCache((v) => !v)}
        width={sidebarWidth}
        onSelectDoc={openDoc}
        onCreateDoc={(parentId) => void createDoc(parentId)}
        onCreateModule={(parentId) => void createModule(parentId)}
        onRenameDoc={(id, title) => void renameDoc(id, title)}
        onSetKind={(id, kind) => void setDocKind(id, kind)}
        onDeleteDoc={(id) => void deleteDoc(id)}
        onSelectConversation={(id) => {
          setActiveConversationId(id);
          setShowCache(false);
        }}
        onCreateConversation={() => void createConversation()}
        onDeleteConversation={(id) => void deleteConversation(id)}
        onOpenSettings={() => setShowSettings(true)}
        onOpenModels={() => setShowModels(true)}
      />

      {/* 侧栏宽度：向右拖 = 侧栏变宽 */}
      <Divider
        orientation="vertical"
        label="调整侧栏宽度"
        onDelta={(d) => setSidebarWidth(sidebarWidth + d)}
        onDoubleClick={() => setSidebarWidth(264)}
      />

      <main className="flex min-w-0 flex-1">
        {showCache ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <CacheDashboard livePlan={livePlan} liveResult={liveResult} />
          </div>
        ) : (
          <>
            {activeDoc?.kind === "module" ? (
              /*
               * 模块容器不显示编辑器 —— 它本来就没有正文。
               * 换成概览页：模块规模、知识点列表、以及三个 AI 学习动作。
               * 这正是用户要的"空组件下面挂载同类知识点"的落地形态。
               */
              <ModuleOverview
                moduleId={activeDoc.id}
                moduleTitle={activeDoc.title || "未命名模块"}
                docs={moduleChildren}
                subModuleCount={moduleSubCount}
                onOpenDoc={openDoc}
                onCreateDoc={() => void createDoc(activeDoc.id)}
                onRunAiAction={handleRunAiAction}
              />
            ) : (
              <EditorPanel
                docId={activeDocId}
                onDocLoaded={handleDocLoaded}
                onReference={handleReference}
                referencedBlockIds={referencedBlockIds}
                onSaved={handleSaved}
              />
            )}

            {/* 对话区宽度：向左拖 = 对话区变宽，所以增量取负 */}
            <Divider
              orientation="vertical"
              label="调整对话区宽度"
              onDelta={(d) => setChatWidth(chatWidth - d)}
              onDoubleClick={() => setChatWidth(460)}
            />

            <div className="flex shrink-0 flex-col" style={{ width: `${chatWidth}px` }}>
              <ChatPanel
                conversation={activeConversation}
                models={models}
                onRefsChanged={handleRefsChanged}
                onConversationUpdated={handleConversationsChanged}
                onTurnComplete={handleTurnComplete}
                onPlanChanged={handlePlanChanged}
                pendingRun={pendingRun}
                onConsumePendingRun={handleConsumePendingRun}
              />
            </div>
          </>
        )}
      </main>

      {/* 弹窗 */}
      {showSettings && (
        <SettingsModal
          workspace={workspace}
          onClose={() => setShowSettings(false)}
          onSaved={(ws) => {
            setWorkspace(ws);
            pushToast(
              "warn",
              "人设或约定已更新。已有会话的对应层级缓存会在下一轮重建，之后恢复命中。",
            );
          }}
        />
      )}

      {showModels && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6 backdrop-blur-sm"
          onClick={() => setShowModels(false)}
        >
          <div
            className="w-full max-w-3xl rounded-xl border border-[#23282f] bg-[#12151a] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#23282f] px-4 py-3">
              <h2 className="text-[13px] font-semibold text-[var(--nodes-ink)]">模型配置</h2>
              <button
                type="button"
                onClick={() => setShowModels(false)}
                aria-label="关闭"
                className="rounded p-1 text-[var(--nodes-ink-faint)] transition-colors hover:text-[var(--nodes-ink)]"
              >
                <X size={14} />
              </button>
            </div>
            <div className="p-4">
              <ModelsPanel />
            </div>
          </div>
        </div>
      )}

      {/* 提示条 */}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[360px] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed shadow-xl",
              t.tone === "warn"
                ? "border-[#f5b544]/30 bg-[#1a1710] text-[#f5b544]"
                : t.tone === "error"
                  ? "border-[#f2555a]/30 bg-[#1a1012] text-[#f2555a]"
                  : t.tone === "ok"
                    ? "border-[#3ddc97]/30 bg-[#0f1a15] text-[#3ddc97]"
                    : "border-[#23282f] bg-[#12151a] text-[var(--nodes-ink-dim)]",
            )}
          >
            {t.tone === "ok" ? (
              <Check size={12} className="mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            )}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
