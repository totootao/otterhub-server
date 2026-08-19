"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Search,
  Folder,
  FileText,
  Film,
  ImageIcon,
  Music,
  Loader2,
  SearchX,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { GlobalSearchResult, globalSearch } from "@/lib/api/browser";
import {
  useBrowserStore,
  useFileDataStore,
  useFileUIStore,
} from "@/stores/file";
import { ViewMode } from "@/lib/types";
import { FileType } from "@shared/types";
import { formatFileSize, formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";

export const OPEN_GLOBAL_SEARCH_EVENT = "otterhub:open-global-search";

const TYPE_META: Record<string, { label: string; icon: typeof ImageIcon }> = {
  [FileType.Image]: { label: "图片", icon: ImageIcon },
  [FileType.Video]: { label: "视频", icon: Film },
  [FileType.Audio]: { label: "音频", icon: Music },
  [FileType.Document]: { label: "文档", icon: FileText },
};

function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
}

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

/** 全局搜索：Cmd/Ctrl+K 或 Header 搜索框触发，跨四种类型检索文件与文件夹 */
export function GlobalSearchDialog() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const seqRef = useRef(0);

  const doSearch = useCallback(async (q: string) => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const { results, total } = await globalSearch(q);
      if (seq === seqRef.current) {
        setResults(results);
        setTotal(total);
      }
    } catch (e) {
      console.error("[GlobalSearch] failed:", e);
      if (seq === seqRef.current) {
        setResults([]);
        setTotal(0);
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  // 输入防抖
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length === 0) {
      setResults([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(q), 350);
    return () => clearTimeout(debounceRef.current);
  }, [query, open, doSearch]);

  // 快捷键 Cmd/Ctrl+K 与自定义事件
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = (e: Event) => {
      // 支持携带初始关键词：detail: { q: string }
      const detail = (e as CustomEvent).detail as { q?: string } | undefined;
      if (detail?.q) setQuery(detail.q);
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_GLOBAL_SEARCH_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_GLOBAL_SEARCH_EVENT, onOpen);
    };
  }, []);

  // 关闭时清空
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setTotal(0);
    }
  }, [open]);

  /** 定位：切换类型 + 进入文件夹视图 + 导航到所在目录 */
  const locate = async (r: GlobalSearchResult) => {
    setOpen(false);
    const targetDir = r.kind === "dir" ? r.path : dirname(r.path);
    const { setActiveType } = useFileDataStore.getState();
    const { setViewMode } = useFileUIStore.getState();
    await setActiveType(r.type);
    setViewMode(ViewMode.Folder);
    // 等待 FolderBrowser 挂载后再导航（reset 默认回根，这里覆盖）
    setTimeout(() => {
      useBrowserStore.getState().navigate(targetDir);
    }, 50);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl top-[15%] translate-y-0 gap-0 p-0 overflow-hidden rounded-2xl border-glass-border bg-popover/95 backdrop-blur-2xl">
        <DialogTitle className="sr-only">全局搜索</DialogTitle>
        <div className="flex items-center gap-3 border-b border-glass-border px-4">
          <Search className="h-5 w-5 shrink-0 text-foreground/40" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索全部文件与文件夹（名称 / 描述 / 标签）..."
            className="h-14 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-foreground/40"
          />
          {loading && (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary/60" />
          )}
          <kbd className="hidden sm:inline-flex h-6 items-center rounded-md border border-glass-border bg-secondary/30 px-2 text-[10px] font-medium text-foreground/40">
            ESC 关闭
          </kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {query.trim() === "" ? (
            <div className="flex flex-col items-center gap-2 py-14 text-foreground/40">
              <Search className="h-8 w-8" />
              <p className="text-sm">输入关键词，跨全部类型搜索</p>
              <p className="text-xs text-foreground/30">
                支持文件名、描述与标签匹配
              </p>
            </div>
          ) : loading && results.length === 0 ? (
            <div className="flex items-center justify-center py-14">
              <Loader2 className="h-6 w-6 animate-spin text-primary/50" />
            </div>
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-14 text-foreground/40">
              <SearchX className="h-8 w-8" />
              <p className="text-sm">未找到与「{query.trim()}」相关的内容</p>
            </div>
          ) : (
            <div className="space-y-1">
              {results.map((r) => {
                const meta = TYPE_META[r.type];
                const Icon =
                  r.kind === "dir" ? Folder : (meta?.icon ?? FileText);
                return (
                  <button
                    key={`${r.type}:${r.kind}:${r.path}`}
                    onClick={() => locate(r)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                      "hover:bg-primary/10 focus-visible:bg-primary/10 focus-visible:outline-none"
                    )}
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary/40 border border-glass-border">
                      {r.kind === "dir" ? (
                        <Folder className="h-5 w-5 text-primary" />
                      ) : (
                        <Icon className="h-5 w-5 text-foreground/70" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-foreground">
                          {basename(r.path)}
                        </p>
                        <span className="shrink-0 rounded-md border border-glass-border bg-secondary/30 px-1.5 py-0.5 text-[10px] font-medium text-foreground/50">
                          {meta?.label ?? r.type}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-foreground/45">
                        {r.kind === "dir"
                          ? `文件夹 · ${dirname(r.path) ? dirname(r.path) + "/" : ""}`
                          : `${dirname(r.path) ? dirname(r.path) + "/" : ""}${formatFileSize(
                              r.item.metadata?.fileSize ?? 0
                            )} · ${formatDate(r.item.metadata?.uploadedAt ?? 0)}`}
                      </p>
                    </div>
                  </button>
                );
              })}
              {total > results.length && (
                <p className="py-2 text-center text-xs text-foreground/40">
                  共 {total} 条结果，仅显示前 {results.length} 条，请细化关键词
                </p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
