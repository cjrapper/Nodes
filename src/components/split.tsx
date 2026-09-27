"use client";

/**
 * 可拖拽分栏。
 *
 * 为什么不用现成的面板库：这里只需要"两个格子 + 一条可拖的边"，
 * 引一个包进来（连同它的样式、上下文、键盘导航实现）比自己写还重。
 * 但自己写必须把三件容易被忽略的事做对：
 *
 *  1. **拖动过程不能触发文本选中** —— 否则鼠标一动整页文字被刷蓝，
 *     看起来像坏了。靠拖拽期间给 body 加 `user-select: none` 解决。
 *  2. **尺寸要落盘** —— 用户费劲调好的宽度，刷新一下就没了是很糟的体验。
 *     用 localStorage 记住（纯界面偏好，不值得进数据库）。
 *  3. **边界要夹住** —— 拖到 0 或拖出屏幕会让面板彻底消失且无法拖回来。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/ui/client";

const STORAGE_PREFIX = "nodes:split:";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 一个带记忆的尺寸值。
 *
 * @param key       localStorage 的键，同一个 key 在不同布局间共享尺寸
 * @param initial   首次使用时的初始值（px）
 * @param min/max   夹取范围（px）
 */
export function useResizableSize(
  key: string,
  initial: number,
  min: number,
  max: number,
): [number, (next: number) => void, () => void] {
  const [size, setSize] = useState(initial);
  const loaded = useRef(false);

  // 挂载后读一次记忆值。放在 effect 里而不是 useState 初始值，
  // 是为了让服务端渲染与首次客户端渲染保持一致，避免 hydration 不匹配。
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_PREFIX + key);
      if (stored !== null) {
        const parsed = Number(stored);
        if (Number.isFinite(parsed)) setSize(clamp(parsed, min, max));
      }
    } catch {
      // 隐私模式等场景下 localStorage 不可用，静默退化为默认尺寸
    }
    loaded.current = true;
  }, [key, min, max]);

  const update = useCallback(
    (next: number) => {
      const value = clamp(next, min, max);
      setSize(value);
      if (loaded.current) {
        try {
          window.localStorage.setItem(STORAGE_PREFIX + key, String(Math.round(value)));
        } catch {
          // 存不进去也不影响本次会话内的使用
        }
      }
    },
    [key, min, max],
  );

  const reset = useCallback(() => {
    update(initial);
  }, [update, initial]);

  return [size, update, reset];
}

/** 拖动期间禁用文本选中与光标闪烁 */
function useDragGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "var(--nodes-drag-cursor, col-resize)";
    return () => {
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };
  }, [active]);
}

interface DividerProps {
  /** 水平分隔条：左右拖动，改的是宽度 */
  orientation: "vertical" | "horizontal";
  /** 拖动增量（px）。正值一律表示"被调整的面板变大" */
  onDelta: (delta: number) => void;
  onDoubleClick?: () => void;
  label: string;
}

export function Divider({ orientation, onDelta, onDoubleClick, label }: DividerProps) {
  const [dragging, setDragging] = useState(false);
  const last = useRef(0);

  useDragGuard(dragging);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    last.current = orientation === "vertical" ? e.clientX : e.clientY;
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const current = orientation === "vertical" ? e.clientX : e.clientY;
    const delta = current - last.current;
    if (delta === 0) return;
    last.current = current;
    // 只报告增量，由调用方决定"变大的那一侧"是谁 —— 这样同一条分隔条
    // 既能服务"右侧面板变宽"，也能服务"左侧面板变宽"
    onDelta(delta);
  };

  const stop = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // 指针已经释放
    }
    setDragging(false);
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={onDoubleClick}
      title={`${label}（拖动调整，双击复位）`}
      className={cn(
        "group relative shrink-0 transition-colors",
        orientation === "vertical" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
        dragging ? "bg-[#3ddc97]/50" : "bg-[#23282f] hover:bg-[#3ddc97]/30",
      )}
    >
      {/* 把命中区域加宽到 9px，但视觉上仍是一条细线 —— 
          1px 的拖动目标太难抓，而 9px 的实心条又太笨重 */}
      <div
        className={cn(
          "absolute",
          orientation === "vertical" ? "-left-1 -right-1 top-0 bottom-0" : "-top-1 -bottom-1 left-0 right-0",
        )}
      />
    </div>
  );
}
