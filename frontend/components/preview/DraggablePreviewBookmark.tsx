"use client";

import React, { useRef, useState } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PreviewType } from "@/stores/preview-store";
import { usePreviewLayoutStore } from "@/stores/preview-layout-store";

const DRAG_THRESHOLD_PX = 4;

interface DraggablePreviewBookmarkProps {
  type: PreviewType;
  title?: string;
  visible: boolean;
  visibleTypes: PreviewType[];
  className?: string;
  children: React.ReactNode;
  onActivate: () => void;
  onClose: (event: React.MouseEvent) => void;
}

/** 右侧贴边、仅支持上下拖拽的 preview 最小化书签。 */
export function DraggablePreviewBookmark({
  type,
  title,
  visible,
  visibleTypes,
  className,
  children,
  onActivate,
  onClose,
}: DraggablePreviewBookmarkProps) {
  const topRatio = usePreviewLayoutStore((s) => s.bookmarkPositions[type]);
  const setBookmarkPosition = usePreviewLayoutStore(
    (s) => s.setBookmarkPosition
  );
  const [isDragging, setIsDragging] = useState(false);
  const [dragTopRatio, setDragTopRatio] = useState<number | null>(null);
  const suppressClickRef = useRef(false);
  const dragStateRef = useRef<{
    startY: number;
    offsetY: number;
    pointerId: number;
    moved: boolean;
  } | null>(null);

  /** 开始记录拖拽手势。 */
  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    dragStateRef.current = {
      startY: event.clientY,
      offsetY: event.clientY - rect.top,
      pointerId: event.pointerId,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  /** 根据指针位置更新书签垂直位置。 */
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;

    const deltaY = Math.abs(event.clientY - state.startY);
    if (deltaY > DRAG_THRESHOLD_PX) {
      state.moved = true;
      setIsDragging(true);
    }

    if (!state.moved) return;

    event.preventDefault();
    setDragTopRatio((event.clientY - state.offsetY) / window.innerHeight);
  };

  /** 结束拖拽并释放 pointer capture。 */
  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;

    if (state.moved) {
      event.preventDefault();
      const nextTopRatio = (event.clientY - state.offsetY) / window.innerHeight;
      setBookmarkPosition(type, nextTopRatio, visibleTypes);
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }

    dragStateRef.current = null;
    setIsDragging(false);
    setDragTopRatio(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  /** 区分点击最大化和拖拽释放。 */
  const handleClick = () => {
    if (suppressClickRef.current) return;
    onActivate();
  };

  return (
    <div
      className={cn(
        "fixed right-0 z-49 group",
        isDragging
          ? "transition-none cursor-grabbing"
          : "transition-all duration-300 ease-in-out cursor-grab",
        visible
          ? "opacity-50 hover:opacity-100 pointer-events-auto"
          : "translate-x-full opacity-0 pointer-events-none"
      )}
      style={{
        top: `${(dragTopRatio ?? topRatio) * 100}%`,
        touchAction: "none",
      }}
      title={title}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onClick={handleClick}
    >
      <div className={className}>{children}</div>

      <div className="absolute -bottom-2 -left-2 opacity-0 group-hover:opacity-100 transition-all duration-200 scale-75 group-hover:scale-100 z-20">
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 rounded-full bg-gray-500/80 hover:bg-destructive text-white shadow-sm p-0.5"
          onClick={onClose}
          title="关闭"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
