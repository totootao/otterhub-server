"use client";

import React, { useEffect, useRef, useState } from "react";
import { usePreviewStore } from "@/stores/preview-store";
import { getFileUrl } from "@/lib/api";
import { Music, Minus, X, Play, Pause } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DraggablePreviewBookmark } from "./DraggablePreviewBookmark";

export function GlobalAudioPlayer() {
  const { audio, video, text, minimize, maximize, close } = usePreviewStore();
  const activeFile = audio?.file;
  const viewState = audio?.viewState;

  const audioRef = useRef<HTMLAudioElement>(null);
  const wasPlayingRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);

  // Auto play when file changes
  useEffect(() => {
    if (activeFile && audioRef.current) {
      audioRef.current.play().catch(() => {});
    }
  }, [activeFile]);

  // Handle interaction with Video player
  useEffect(() => {
    if (video?.viewState === "full") {
      // If video goes full, pause audio if it's playing
      if (audioRef.current && !audioRef.current.paused) {
        wasPlayingRef.current = true;
        audioRef.current.pause();
      }
    } else {
      // If video minimizes/closes, resume if we paused it
      if (wasPlayingRef.current && audioRef.current) {
        audioRef.current.play().catch(() => {});
        wasPlayingRef.current = false;
      }
    }
  }, [video?.viewState]);

  if (!activeFile) return null;

  const url = getFileUrl(activeFile.name);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
    }
  };

  return (
    <>
      {/* FULL VIEW OVERLAY */}
      <div
        className={cn(
          "fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm transition-all duration-300",
          viewState === "full"
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none scale-95"
        )}
        onClick={(e) => {
          if (e.target === e.currentTarget) minimize("audio");
        }}
      >
        <div className="relative w-full max-w-md p-6 bg-background/95 backdrop-blur-xl border border-border shadow-2xl rounded-3xl flex flex-col items-center gap-6 m-4">
          {/* Header Actions */}
          <div className="absolute top-4 right-4 flex gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => minimize("audio")}
              title="最小化"
            >
              <Minus className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => close("audio")}
              title="关闭"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Visual Icon */}
          <div className="w-24 h-24 rounded-2xl bg-primary/10 flex items-center justify-center text-primary shadow-inner mt-2">
            <Music className="w-10 h-10" strokeWidth={1.5} />
          </div>

          {/* File Info */}
          <div className="text-center px-4 w-full">
            <h3 className="font-semibold text-lg leading-tight truncate select-all text-foreground">
              {activeFile.metadata?.fileName}
            </h3>
          </div>

          {/* Player (Native Controls) */}
          <div className="w-full bg-secondary/50 rounded-xl p-2">
            <audio
              ref={audioRef}
              src={url}
              controls
              className="w-full h-10 outline-none accent-primary block"
              style={{ filter: "drop-shadow(0 2px 4px rgb(0 0 0 / 0.1))" }}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
            />
          </div>
        </div>
      </div>

      {/* MINIMIZED BOOKMARK (Right Side) */}
      <DraggablePreviewBookmark
        type="audio"
        visible={viewState === "minimized"}
        visibleTypes={[
          "audio",
          ...(video?.viewState === "minimized" ? ["video" as const] : []),
          ...(text?.viewState === "minimized" ? ["text" as const] : []),
        ]}
        title={activeFile.metadata?.fileName}
        className="relative flex items-center justify-center bg-background/80 backdrop-blur-md border border-r-0 border-border shadow-md rounded-l-full w-11 h-9"
        onActivate={() => maximize("audio")}
        onClose={(e) => {
          e.stopPropagation();
          close("audio");
        }}
      >
        {isPlaying && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-0">
            <div className="absolute w-4 h-4 rounded-full bg-primary/60 animate-[ripple_2.5s_ease-out_infinite]" />
            <div className="absolute w-4 h-4 rounded-full bg-primary/40 animate-[ripple_2.5s_ease-out_infinite_0.8s]" />
            <div className="absolute w-4 h-4 rounded-full bg-primary/20 animate-[ripple_2.5s_ease-out_infinite_1.6s]" />
          </div>
        )}

        <Button
          variant="ghost"
          size="icon"
          className="z-10 h-8 w-8 rounded-full hover:bg-primary/10 hover:text-primary transition-transform active:scale-90"
          onClick={togglePlay}
        >
          {isPlaying ? (
            <Pause className="h-4 w-4 fill-current" />
          ) : (
            <Play className="h-4 w-4 fill-current ml-0.5" />
          )}
        </Button>
      </DraggablePreviewBookmark>
    </>
  );
}
