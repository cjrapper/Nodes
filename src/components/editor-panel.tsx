"use client";

/**
 * Markdown 编辑器：左编辑、右预览，预览的每一块都带"块标识"。
 *
 * 与普通 Markdown 编辑器最大的不同：**块是一等公民**。
 * 右侧预览按块渲染，每个块旁边显示它的 8 位块标识、被引用次数，
 * 以及一个「@」按钮 —— 点一下就把这个块挂到当前对话里。
 * 这样"写"和"用"是同一个界面里的动作，不需要先保存再去别处搜索。
 */

import { AlertTriangle, AtSign, Check, Eye, HelpCircle, ImagePlus, ListTree, Loader2, Pencil, Save, SplitSquareHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import OutlinePanel, { estimateOutlineWidth } from "@/components/outline-panel";
import DiagramBlock from "@/components/diagram-block";
import { Divider, useResizableSize } from "@/components/split";
import { api, cn, formatTokens, uploadAsset } from "@/lib/ui/client";
import { resolveDiagramLink } from "@/lib/ui/diagram-links";
import { useRenderWatchdog, useStableCallback } from "@/lib/ui/hooks";
import type { BlockView, DocView } from "@/lib/ui/types";
import { parseMarkdown } from "@/lib/blocks/parse-blocks";
import { COLOR_LEGEND, renderMarkdownToHtml } from "@/lib/render/markdown";

type Mode = "split" | "edit" | "preview";

/**
 * 语法速查里每种颜色的示例色值。
 *
 * 必须与 `lib/render/markdown.ts` 的 `COLOR_CLASSES` 对应 —— 那边是
 * `{名字|文字}` 真正生效的地方，这里是"给用户看一眼"。改色值时两处一起改；
 * 名字对不上时 `?? 兜底` 会让它退回正文色，不会渲染出坏样式。
 */
const LEGEND_SWATCH: Record<string, string> = {
  red: "text-[#f2555a]",
  orange: "text-[#f5b544]",
  green: "text-[#3ddc97]",
  blue: "text-[#6aa8ff]",
  purple: "text-[#a78bfa]",
  mark: "rounded-sm bg-[#f5b544]/20 px-0.5",
};

interface EditorPanelProps {
  docId: string | null;
  onDocLoaded?: (doc: DocView) => void;
  onTitleChange?: (docId: string, title: string) => void;
  onReference: (blockId: string) => void;
  referencedBlockIds: string[];
  /** 保存成功后回调，让上层感知缓存影响 */
  onSaved: (impact: {
    changedBlockCount: number;
    affectedBlockCount: number;
    totalAffectedRefs: number;
    hasImpact: boolean;
  }) => void;
  /**
   * 预览滚动容器的覆盖值。**仅供测试**。
   *
   * 为什么需要它：滚动跟随与"当前块"高亮依赖 `IntersectionObserver` +
   * `querySelectorAll`，而测试环境（react-test-renderer）两者都没有。
   * 不给测试一条注入路径的话，这段逻辑就完全测不到 —— 而它恰好是
   * 一个真实渲染循环的发生地（详见下面 observer effect 的注释）。
   *
   * 生产代码永远不传这个 prop，`previewRef` 仍然指向真实 DOM 节点。
   */
  previewContainerOverride?: HTMLElement | null;
}

interface LoadResponse {
  doc: DocView;
  markdown: string;
  blockIds: string[];
  blocks: BlockView[];
}

export default function EditorPanel({
  docId,
  onDocLoaded,
  onTitleChange,
  onReference,
  referencedBlockIds,
  onSaved,
  previewContainerOverride,
}: EditorPanelProps) {
  const [markdown, setMarkdown] = useState("");
  const [blockIds, setBlockIds] = useState<string[]>([]);
  const [blocks, setBlocks] = useState<BlockView[]>([]);
  const [doc, setDoc] = useState<DocView | null>(null);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<Mode>("split");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  /*
   * 大纲面板。
   *
   * 用户反馈"笔记区想分成大块整理，再细分"——块本身已经是最小引用单位，
   * 缺的是**在长文档里看见结构并跳过去**的能力。大纲解决了这个：
   * 标题层级一目了然，点一下就能跳到对应位置。
   *
   * 折叠状态与宽度都记住，因为长文档里用户会反复切换。
   */
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [outlineWidth, setOutlineWidth] = useResizableSize("outline", 210, 168, 340);
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);

  /*
   * 图片上传。
   *
   * 编辑器是个纯 <textarea>，所以"插入"这件事必须自己实现：
   * 拿到光标位置 → 把 Markdown 片段拼进去 → 恢复光标到片段之后。
   * 三种入口（工具栏选文件 / 直接粘贴 / 拖拽落图）都收敛到
   * `insertImages`，行为完全一致 —— 分散成三份实现必然出现
   * "粘贴会换行、拖拽不会"这种不一致。
   */
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /** 语法速查面板：默认收起，但入口常驻（见下方面板处的注释） */
  const [syntaxOpen, setSyntaxOpen] = useState(false);

  // 开发期看门狗：万一将来又引入渲染循环，控制台会直接点名，不用靠猜
  useRenderWatchdog("EditorPanel");

  // 用 ref 保存最新值，供自动保存的定时器读取，避免闭包捕获旧状态
  const latest = useRef({ markdown, blockIds, docId, dirty });
  latest.current = { markdown, blockIds, docId, dirty };

  /*
   * 父组件传下来的回调必须钉成稳定引用。
   *
   * 它们原来是内联箭头函数，引用每次父组件渲染都会变；一旦出现在下面
   * `load` / `save` 的依赖数组里，就会形成渲染循环：
   *   load → onDocLoaded → 父组件 setState → 重渲染 → 新的 onDocLoaded
   *   → load 重建 → effect 重跑 → load …
   * 症状是文档列表疯狂闪烁、终端被 /api/blocks 请求刷屏。
   */
  const notifyDocLoaded = useStableCallback(onDocLoaded);
  const notifySaved = useStableCallback(onSaved);

  const load = useCallback(
    async (id: string) => {
      setLoading(true);
      setError(null);
      try {
        const data = await api.get<LoadResponse>(`/api/blocks?docId=${encodeURIComponent(id)}`);
        setDoc(data.doc);
        setTitle(data.doc.title);
        setMarkdown(data.markdown);
        setBlockIds(data.blockIds);
        setBlocks(data.blocks);
        setDirty(false);
        setSavedAt(null);
        notifyDocLoaded(data.doc);
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载失败");
      } finally {
        setLoading(false);
      }
    },
    [notifyDocLoaded],
  );

  useEffect(() => {
    if (!docId) {
      setDoc(null);
      setMarkdown("");
      setBlocks([]);
      setBlockIds([]);
      return;
    }
    void load(docId);
  }, [docId, load]);

  const save = useCallback(
    async (overrides?: { title?: string }) => {
      const { markdown: md, blockIds: ids, docId: id } = latest.current;
      if (!id) return;
      setSaving(true);
      setError(null);
      try {
        // 若同时改了标题，先落标题（标题影响块的 path 渲染，但不影响 cacheKey）
        if (overrides?.title !== undefined) {
          await api.patch("/api/docs", { id, title: overrides.title });
        }
        const result = await api.put<{
          blockIds: string[];
          blocks: BlockView[];
          cacheImpact: {
            changedBlockCount: number;
            affectedBlockCount: number;
            totalAffectedRefs: number;
            hasImpact: boolean;
          };
        }>("/api/blocks", { docId: id, markdown: md, blockIds: ids });

        setBlockIds(result.blockIds);
        setBlocks(result.blocks);
        setDirty(false);
        setSavedAt(Date.now());
        notifySaved(result.cacheImpact);
      } catch (err) {
        setError(err instanceof Error ? err.message : "保存失败");
      } finally {
        setSaving(false);
      }
    },
    [notifySaved],
  );

  // 自动保存：停止输入 1.5 秒后落盘。块是引用单位，未保存的内容无法被 @ 引用。
  useEffect(() => {
    if (!dirty || !docId) return;
    const timer = setTimeout(() => {
      void save();
    }, 1500);
    return () => clearTimeout(timer);
  }, [dirty, docId, markdown, save]);

  // Ctrl/Cmd + S 手动保存
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [save]);

  const previewHtml = useMemo(() => {
    // 实时预览：直接对当前编辑内容就地解析，这样还没保存就能看到块结构变化。
    // 服务端保存时会用同一套解析逻辑（共用 parse-blocks 模块），因此
    // 预览里的块划分与保存后的块划分一致，不会"看着是 3 块、存下去变 4 块"。
    const parsed = parseMarkdown(markdown);
    return parsed.map((p, index) => {
      const saved = blocks[index];
      // 对齐已保存的块 id：位置未变的块能拿到稳定标识（可被 @ 引用）；
      // 新插入或错位的块暂时用 index 作为本地 key，保存后即有真 id。
      const aligned = saved && saved.kind === p.kind ? saved : null;
      return {
        key: aligned?.id ?? `local_${index}`,
        id: aligned?.id ?? null,
        cacheKey: aligned?.cacheKey ?? null,
        kind: p.kind,
        // 原始 Markdown 片段：大纲面板需要它来解析标题层级
        rawText: p.text,
        path: aligned?.path ?? doc?.title ?? "",
        refCount: aligned?.refCount ?? 0,
        html: renderMarkdownToHtml(p.text),
        tokens: Math.ceil(p.text.length / 2.2),
      };
    });
  }, [markdown, blocks, doc?.title]);

  /**
   * 大纲面板需要的块序列。
   *
   * 与 previewHtml 用同一份解析结果，保证"大纲里看到的标题"和
   * "正文里的标题"永远一致 —— 两处各自解析一遍迟早会漂移。
   */
  const outlineBlocks = useMemo(
    () =>
      previewHtml.map((b, index) => ({
        id: b.key,
        kind: b.kind,
        text: b.rawText,
        seq: index,
      })),
    [previewHtml],
  );

  /**
   * 大纲宽度按标题实际长度自适应。
   *
   * ## 语义：自适应，但尊重用户的手动调整
   *
   * 两种失败方式都要避免：
   *  - 宽度固定 → 长标题被截断或折成三四行，很难扫视；
   *  - 每次打开文档都强制重算 → 用户手动拖过的宽度一直被冲掉，很烦。
   *
   * 所以规则是：**只有在"当前宽度放不下这个文档的标题"时才自动加宽**。
   * 用户调宽过就一直够用（不会被动），调窄过、遇到长标题则会自动补上。
   * 比"记住用户是否手动调过"更简单，也更少出现意外。
   *
   * ⚠️ 两个细节都是踩过的坑：
   *  1. 用 ref 读当前宽度，**不能把 `outlineWidth` 写进依赖** ——
   *     否则 effect 会被自己的 setState 再次触发（AGENTS.md R12 那类自激）。
   *  2. `useResizableSize` 的 setter 只接受数字，不是 React 那种
   *     `setX(prev => ...)` 形式，所以这里不能写成 updater。
   */
  const outlineWidthRef = useRef(outlineWidth);
  outlineWidthRef.current = outlineWidth;

  useEffect(() => {
    const fitted = estimateOutlineWidth(outlineBlocks);
    if (fitted > outlineWidthRef.current) setOutlineWidth(fitted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outlineBlocks]);

  /**
   * 设置"正在看的块"，值没变就什么都不做。
   *
   * 用 ref 读当前值而不是把它写进依赖，这样这个函数永远稳定 ——
   * 它会被下面的 IntersectionObserver effect 依赖，一旦引用会变
   * 就会导致 observer 被反复重建。
   */
  const activeBlockRef = useRef<string | null>(null);
  const setActiveBlock = useCallback((next: string) => {
    if (activeBlockRef.current === next) return;
    activeBlockRef.current = next;
    setActiveBlockId(next);
  }, []);

  /** 大纲点击后滚动到对应块。用 scrollIntoView 而不是手算偏移量，
      因为预览区是可滚动的独立容器，手算容易在字体变化后失准。 */
  const scrollToBlock = useCallback(
    (blockKey: string) => {
      const container = previewRef.current;
      if (!container) return;
      const target = container.querySelector<HTMLElement>(
        `[data-block-key="${CSS.escape(blockKey)}"]`,
      );
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
      setActiveBlock(blockKey);
    },
    [setActiveBlock],
  );

  /**
   * 把若干张图插进正文的光标处。
   *
   * ## 为什么要手动接管光标
   *
   * `<textarea>` 的 value 由 React 托管，`setMarkdown` 之后 React 会把
   * DOM 的 value 覆写回去，浏览器**不会**帮你移动光标 —— 结果是每插一张图，
   * 光标都跳回原处，连插三张图会得到三张图叠在同一个位置、顺序还反了。
   * 所以这里自己算新光标位置并在下一帧写回 selectionStart/End。
   *
   * ## 为什么按"块"插入而不是就地插一行
   *
   * 图片是块级元素，夹在句子中间会让那一行渲染成 `文字 [图] 文字`，
   * 看起来像坏掉。统一"前后留空行、独占一段"，与 Markdown 的块语义一致
   * （`parseMarkdown` 也据此把图归到一个独立块里，从而能单独被 @ 引用）。
   */
  const insertImages = useCallback((snippets: string[], atEnd = false) => {
    if (snippets.length === 0) return;
    const block = snippets.join("\n\n");

    const el = textareaRef.current;
    // 仅预览模式下 textarea 不存在：追加到末尾，用户切回编辑就能看到
    const start = atEnd || el === null ? null : el.selectionStart;
    const end = atEnd || el === null ? null : el.selectionEnd;

    setMarkdown((prev) => {
      if (start === null || end === null) {
        const sep = prev.length === 0 || prev.endsWith("\n\n") ? "" : prev.endsWith("\n") ? "\n" : "\n\n";
        return `${prev}${sep}${block}\n`;
      }
      // 前后补空行：保证图片自成一段，不会和前后的文字挤在同一段里。
      // 已经处于段落边界时不重复补，避免每插一张图就多出一行空白。
      const needsLead = start > 0 && !prev.slice(0, start).endsWith("\n\n");
      const needsTail = end < prev.length && !prev.slice(end).startsWith("\n\n");
      const insert = `${needsLead ? "\n\n" : ""}${block}${needsTail ? "\n\n" : ""}`;
      const next = prev.slice(0, start) + insert + prev.slice(end);

      // 光标落到插入内容之后。等 React 提交完再写回，否则会被 value 覆写冲掉。
      const caret = start + insert.length;
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(caret, caret);
      });
      return next;
    });

    setDirty(true);
  }, []);

  /**
   * 上传一批文件并插入。
   *
   * 逐张上传而不是并发：图片走的是本地磁盘，并发几乎没有收益，却会让
   * 失败时的顺序变得不可预测（用户看到"第 3 张失败"却不知道是哪张）。
   * 串行还能保证插入顺序和用户选择顺序一致。
   *
   * 单张失败**不中断**整批：一次选 5 张、第 2 张格式不对，
   * 剩下 3 张应该照常插入，只把错误报出来。
   */
  const uploadFiles = useCallback(
    async (files: File[], atEnd = false) => {
      const images = files.filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(f.name));
      if (images.length === 0) {
        setUploadError("没有可插入的图片（支持 PNG / JPEG / GIF / WebP）。");
        return;
      }

      setUploadError(null);
      setUploading((n) => n + images.length);
      const snippets: string[] = [];
      const failures: string[] = [];

      for (const file of images) {
        try {
          const asset = await uploadAsset(file);
          // 用文件名当说明文字：比空 alt 有用得多 —— 每张图下面直接显示
          // "受击判定框.png"，用户回头能认出来，也方便读屏软件
          const name = file.name.replace(/\.[^.]+$/, "");
          const alt = name && name !== "image" ? name : "";
          // asset.markdown 是 `![](asset:xxx)`，带上说明时替换掉空的 `[]`
          snippets.push(alt ? asset.markdown.replace("![](", `![${alt}](`) : asset.markdown);
        } catch (err) {
          failures.push(`${file.name}：${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setUploading((n) => Math.max(0, n - 1));
        }
      }

      if (snippets.length > 0) insertImages(snippets, atEnd);
      if (failures.length > 0) setUploadError(failures.join("；"));
    },
    [insertImages],
  );

  /** 只保留图片文件，供拖拽与粘贴共用 */
  const pickImageFiles = (list: FileList | null | undefined): File[] => {
    if (!list) return [];
    return Array.from(list).filter((f) => f.type.startsWith("image/"));
  };


  /**
   * 跟踪当前滚动到哪个块，让大纲高亮跟随。
   *
   * 用 IntersectionObserver 而不是 scroll 事件：后者在高频滚动时每帧都要
   * 遍历所有块算位置，长文档会明显掉帧。
   *
   * ## 这里踩过一个渲染循环的坑
   *
   * 第一版在回调里**无条件** `setActiveBlockId(bestKey)`。看起来无害，
   * 实际会形成回路：
   *
   *   observer 回调 → setState（哪怕值没变）→ 重渲染 → effect 依赖变化
   *   → 重建 observer → 立即回调 → …
   *
   * React 对同一个值重复 setState 虽然会 bail out 掉*子树*的渲染，但组件
   * 本身已经进了渲染流程；配合"重建 observer"就足以让计数一路涨到看门狗报警。
   * 而且这条回路只在真实浏览器里成立 —— 测试环境的 IntersectionObserver 桩
   * 不回调，所以单测完全看不到它。
   *
   * 两条修正：
   *  1. 回调里先比较，值没变就直接返回（用 ref 读当前值，省掉依赖）；
   *  2. observer 只在闭包真正失效时重建 —— 依赖 `previewHtml` 对象本身
   *     而不是它的长度：长度没变但内容变了时，旧闭包里的节点已经过时。
   */
  useEffect(() => {
    // 测试可注入一个假容器；生产环境走真实 DOM 引用
    const container = previewContainerOverride ?? previewRef.current;
    if (!container || !outlineOpen) return;

    const nodes = Array.from(container.querySelectorAll<HTMLElement>("[data-block-key]"));
    if (nodes.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // 取当前可见度最高的那个块作为"正在看的块"
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        const best = visible[0]?.target as HTMLElement | undefined;
        if (best?.dataset.blockKey) setActiveBlock(best.dataset.blockKey);
      },
      {
        root: container,
        // 只在接近顶部的那一带判定，否则"可见的块"会有很多个
        rootMargin: "0px 0px -70% 0px",
        threshold: [0, 0.25, 0.5, 1],
      },
    );

    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [outlineOpen, previewHtml, mode, setActiveBlock, previewContainerOverride]);

  const commitTitle = () => {
    if (!doc || title === doc.title) return;
    onTitleChange?.(doc.id, title);
    void save({ title });
  };

  if (!docId) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-[#0b0d10]">
        <div className="max-w-sm text-center">
          <p className="text-[13px] text-[var(--nodes-ink-dim)]">还没有选中文档</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--nodes-ink-faint)]">
            在左侧新建一篇文档，写下的每个段落都会成为一个可被 @ 引用的「知识块」。
            被引用的块会稳定地进入 AI 上下文，并在多轮对话之间复用缓存。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-[#0b0d10]">
      {/* 工具条 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[#23282f] px-3 py-2">
        {/*
          标题框必须有可见的边框与 hover 反馈。
          原先它长得和静态文字完全一样（无边框、无底色），结果是用户
          根本找不到"给文档改名"的入口，只能一直看到"未命名文档"。
          旁边额外挂一个铅笔图标，进一步提示这里可以点。
        */}
        <div className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 transition-colors hover:border-[#23282f] focus-within:border-[#3ddc97]/50 focus-within:bg-[#0b0d10]">
          <Pencil
            size={11}
            className="shrink-0 text-[var(--nodes-ink-faint)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          />
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            aria-label="文档标题（点这里改名）"
            title="点这里改名，回车或点别处保存"
            className="min-w-0 flex-1 bg-transparent text-[14px] font-semibold text-[var(--nodes-ink)] placeholder:text-[var(--nodes-ink-faint)]"
            placeholder="未命名文档"
          />
        </div>

        <div className="flex shrink-0 items-center gap-1 rounded-md bg-[#12151a] p-0.5">
          {/*
            插入图片。隐藏的 <input type="file"> 由一个普通按钮触发 ——
            浏览器不允许用脚本打开文件选择框，只能点真实的 input，
            所以这是唯一可靠的写法。
          */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            className="hidden"
            onChange={(e) => {
              void uploadFiles(Array.from(e.target.files ?? []));
              // 必须清空：否则连续选同一个文件不会触发 change
              e.target.value = "";
            }}
          />
          <button
            type="button"
            title="插入图片（也可以直接粘贴或拖进来）"
            aria-label="插入图片"
            disabled={uploading > 0}
            onClick={() => fileInputRef.current?.click()}
            className="rounded p-1.5 text-[var(--nodes-ink-faint)] transition-colors hover:text-[var(--nodes-ink-dim)] disabled:opacity-40"
          >
            {uploading > 0 ? <Loader2 size={13} className="animate-spin" /> : <ImagePlus size={13} />}
          </button>
          <button
            type="button"
            title="语法速查（颜色 / 表格 / 图表 / 图片）"
            aria-label="切换语法速查"
            aria-pressed={syntaxOpen}
            onClick={() => setSyntaxOpen((v) => !v)}
            className={cn(
              "rounded p-1.5 transition-colors",
              syntaxOpen
                ? "bg-[#23282f] text-[var(--nodes-ink)]"
                : "text-[var(--nodes-ink-faint)] hover:text-[var(--nodes-ink-dim)]",
            )}
          >
            <HelpCircle size={13} />
          </button>
          <button
            type="button"
            title={outlineOpen ? "隐藏大纲" : "显示大纲"}
            aria-label="切换大纲面板"
            aria-pressed={outlineOpen}
            onClick={() => setOutlineOpen((v) => !v)}
            className={cn(
              "rounded p-1.5 transition-colors",
              outlineOpen ? "bg-[#23282f] text-[var(--nodes-ink)]" : "text-[var(--nodes-ink-faint)] hover:text-[var(--nodes-ink-dim)]",
            )}
          >
            <ListTree size={13} />
          </button>
          {(
            [
              ["edit", Pencil, "仅编辑"],
              ["split", SplitSquareHorizontal, "分栏"],
              ["preview", Eye, "仅预览"],
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              key={key}
              type="button"
              title={label}
              aria-label={label}
              onClick={() => setMode(key)}
              className={cn(
                "rounded p-1.5 transition-colors",
                mode === key ? "bg-[#23282f] text-[var(--nodes-ink)]" : "text-[var(--nodes-ink-faint)] hover:text-[var(--nodes-ink-dim)]",
              )}
            >
              <Icon size={13} />
            </button>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-2 text-[10px]">
          {uploadError && (
            <span className="flex max-w-[280px] items-center gap-1 text-[#f2555a]" title={uploadError}>
              <AlertTriangle size={11} className="shrink-0" />
              <span className="truncate">{uploadError}</span>
            </span>
          )}
          {!uploadError && uploading > 0 && (
            <span className="flex items-center gap-1 text-[var(--nodes-ink-faint)]">
              <Loader2 size={11} className="animate-spin" />
              上传中 {uploading}
            </span>
          )}
          {!uploadError && uploading === 0 && error && (
            <span className="flex items-center gap-1 text-[#f2555a]">
              <AlertTriangle size={11} />
              {error}
            </span>
          )}
          {!uploadError && uploading === 0 && !error && saving && (
            <span className="text-[var(--nodes-ink-faint)]">保存中…</span>
          )}
          {!uploadError && uploading === 0 && !error && !saving && dirty && (
            <span className="text-[#f5b544]">未保存</span>
          )}
          {!uploadError && uploading === 0 && !error && !saving && !dirty && savedAt && (
            <span className="flex items-center gap-1 text-[#3ddc97]">
              <Check size={11} />
              已保存
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !dirty}
          className="flex shrink-0 items-center gap-1 rounded-md bg-[#3ddc97]/15 px-2 py-1 text-[11px] text-[#3ddc97] transition-colors hover:bg-[#3ddc97]/25 disabled:opacity-40"
        >
          <Save size={11} />
          保存
        </button>
      </div>

      {/*
        语法速查。

        ## 为什么需要它

        `{red|重点}`、```diagram、表格这些能力**早就实现了**，但界面上没有任何
        地方提到它们 —— `COLOR_LEGEND` 甚至导出了却从没被引用过。
        用户只能靠猜，于是"字体颜色调不了"、"不支持网格"这类反馈就来了：
        不是功能缺失，是**发现不了**。

        做成折叠面板而不是常驻：这些都是写几次就记住的语法，
        常驻会长期占掉正文的空间；但入口必须一直在，不能藏在帮助文档里。
      */}
      {syntaxOpen && (
        <div className="shrink-0 space-y-2 border-b border-[#23282f] bg-[#12151a] px-3 py-2 text-[11px] leading-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[var(--nodes-ink-faint)]">文字颜色</span>
            {COLOR_LEGEND.map((item) => (
              <button
                key={item.name}
                type="button"
                title={`插入 {${item.name}|文字}`}
                onClick={() => insertImages([`{${item.name}|文字}`])}
                className="rounded border border-[#23282f] px-1.5 py-0.5 transition-colors hover:border-[#3ddc97]/50"
              >
                {/*
                  直接用 Tailwind 写出每种颜色的示例，而不是拿 renderInline
                  的输出塞进 innerHTML —— 那需要正则剥掉外层 span，脆且没必要。
                  这里的色值与 COLOR_CLASSES 一一对应，改颜色时两处一起改。
                */}
                <span className={LEGEND_SWATCH[item.name] ?? "text-[var(--nodes-ink)]"}>{item.label}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-[var(--nodes-ink-dim)]">
            <span>
              <span className="text-[var(--nodes-ink-faint)]">表格</span> | 列1 | 列2 |
            </span>
            <span>
              <span className="text-[var(--nodes-ink-faint)]">图表</span> ```diagram
            </span>
            <span>
              <span className="text-[var(--nodes-ink-faint)]">图片</span> 直接粘贴 / 拖入 / 点上方图片按钮
            </span>
            <span>
              <span className="text-[var(--nodes-ink-faint)]">引用块</span> 选中文字后点「@」
            </span>
          </div>
        </div>
      )}

      {/* 正文区 */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--nodes-ink-faint)]">
          加载中…
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 大纲：长文档里"看见结构并跳过去"的能力 */}
          {outlineOpen && (
            <>
              <div className="shrink-0 overflow-hidden" style={{ width: `${outlineWidth}px` }}>
                <OutlinePanel
                  blocks={outlineBlocks}
                  activeBlockId={activeBlockId}
                  onNavigate={scrollToBlock}
                />
              </div>
              <Divider
                orientation="vertical"
                label="调整大纲宽度"
                onDelta={(d) => setOutlineWidth(outlineWidth + d)}
                onDoubleClick={() => setOutlineWidth(210)}
              />
            </>
          )}

          {mode !== "preview" && (
            <textarea
              ref={textareaRef}
              value={markdown}
              onChange={(e) => {
                setMarkdown(e.target.value);
                setDirty(true);
              }}
              /*
               * 粘贴图片：截图工具（微信/QQ/Win+Shift+S）出来的就是剪贴板里的
               * 图片文件，直接 Ctrl+V 就能进正文，这是记游戏知识时最顺手的路径 ——
               * 比"先存成文件再点按钮选"少两步。
               *
               * 剪贴板里同时有图片和文本时不拦截文本粘贴：只有真的存在
               * 图片文件才 preventDefault，否则会把从网页复制带格式的文字也吃掉。
               */
              onPaste={(e) => {
                const files = pickImageFiles(e.clipboardData?.files);
                if (files.length === 0) return;
                e.preventDefault();
                void uploadFiles(files);
              }}
              onDragOver={(e) => {
                // 必须 preventDefault，否则浏览器会拒绝 drop 事件
                if (!e.dataTransfer.types.includes("Files")) return;
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                const files = pickImageFiles(e.dataTransfer?.files);
                if (files.length === 0) return;
                e.preventDefault();
                setDragOver(false);
                void uploadFiles(files);
              }}
              spellCheck={false}
              aria-label="Markdown 正文"
              // 字号/行高/字体由 globals.css 里的 CSS 变量统一提供，
              // 这样外观设置能生效，同时不用把字号一路透传成 props
              data-nodes-editor=""
              className={cn(
                "h-full resize-none bg-transparent p-4 font-mono text-[#c9d1d9] placeholder:text-[var(--nodes-ink-faint)]",
                mode === "split" ? "w-1/2 border-r border-[#23282f]" : "flex-1",
                // 拖拽悬停时给一条明显的内描边，否则用户不知道"能不能松手"
                dragOver && "ring-2 ring-inset ring-[#3ddc97]/60",
              )}
              placeholder={"# 标题\n\n直接写 Markdown。空行分隔的每个段落会自动成为一个可被 @ 引用的知识块。\n\n图片可以直接粘贴或拖进来。"}
            />
          )}

          {mode !== "edit" && (
            <div ref={previewRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {previewHtml.length === 0 ? (
                <p className="text-[12px] text-[var(--nodes-ink-faint)]">
                  还没有内容。左侧写下第一段，右侧就会把每个块列出来。
                </p>
              ) : (
                <div className="space-y-1">
                  {previewHtml.map((b) => {
                    const referenced = b.id !== null && referencedBlockIds.includes(b.id);
                    const isActive = b.key === activeBlockId;
                    return (
                      <div
                        key={b.key}
                        // 供大纲跳转与 IntersectionObserver 定位
                        data-block-key={b.key}
                        className={cn(
                          "group relative rounded-lg border px-2.5 py-1.5 transition-colors",
                          isActive
                            ? "border-[#3ddc97]/30 bg-[#12151a]"
                            : "border-transparent hover:border-[#23282f] hover:bg-[#12151a]",
                        )}
                      >
                        {/* 块左边缘的颜色条：标识这是一个可引用的独立单元 */}
                        <span
                          className={cn(
                            "absolute top-2 bottom-2 left-0 w-[2px] rounded-full",
                            referenced ? "bg-[#3ddc97]" : "bg-[#23282f] group-hover:bg-[#3ddc97]/40",
                          )}
                        />

                        {b.kind === "diagram" ? (
                          /*
                           * 图表块单独渲染：块正文里存的是带 ``` 围栏的图语法，
                           * 所以这里直接把它交给图表组件（它会自己剥围栏）。
                           * 用 rawText 而不是 html —— markdown 渲染器只会把它
                           * 当成一段普通代码块，出不来图。
                           */
                          <DiagramBlock
                            source={b.rawText}
                            readOnly
                            resolveLink={resolveDiagramLink}
                            className="my-1"
                          />
                        ) : (
                          <div
                            className="nodes-md"
                            dangerouslySetInnerHTML={{ __html: b.html }}
                          />
                        )}

                        {/* 块元信息 + @ 按钮 */}
                        <div className="mt-1 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                          <span className="font-mono text-[9px] text-[var(--nodes-ink-faint)]">
                            {b.cacheKey ? `#${b.cacheKey.slice(0, 8)}` : "未保存"}
                          </span>
                          {b.path && (
                            <span className="truncate text-[9px] text-[var(--nodes-ink-faint)]">{b.path}</span>
                          )}
                          <span className="shrink-0 text-[9px] text-[var(--nodes-ink-faint)]">
                            {formatTokens(b.tokens)} tok
                          </span>
                          {b.refCount > 0 && (
                            <span className="shrink-0 text-[9px] text-[#f5b544]">
                              {b.refCount} 个会话引用
                            </span>
                          )}
                          <button
                            type="button"
                            disabled={b.id === null}
                            onClick={() => {
                              if (b.id) onReference(b.id);
                            }}
                            title={
                              b.id === null
                                ? "内容尚未保存，保存后即可引用"
                                : referenced
                                  ? "已在当前对话中"
                                  : "把这个块挂到当前对话"
                            }
                            className={cn(
                              "ml-auto flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] transition-colors",
                              b.id === null
                                ? "cursor-not-allowed bg-[#171b21] text-[var(--nodes-ink-faint)]"
                                : referenced
                                  ? "bg-[#3ddc97]/15 text-[#3ddc97]"
                                  : "bg-[#171b21] text-[var(--nodes-ink-dim)] hover:text-[#3ddc97]",
                            )}
                          >
                            <AtSign size={10} />
                            {b.id === null ? "待保存" : referenced ? "已挂载" : "引用"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
