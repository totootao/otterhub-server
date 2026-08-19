"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronRight,
  FolderPlus,
  Home,
  Loader2,
  RefreshCw,
  CircleAlert,
  Upload,
  FolderX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileCard } from "@/components/file-card";
import { ViewModeToggle } from "@/components/ViewModeToggle";
import { PromptDialog } from "./PromptDialog";
import { FolderCard } from "./FolderCard";
import { useBrowserStore, useFileDataStore } from "@/stores/file";
import {
  deleteBrowser,
  mkdirBrowser,
  renameBrowser,
  uploadToDir,
} from "@/lib/api/browser";
import { FileType } from "@shared/types";

const TYPE_LABELS: Record<string, string> = {
  [FileType.Image]: "Images",
  [FileType.Video]: "Videos",
  [FileType.Audio]: "Audio",
  [FileType.Document]: "Documents",
};

/** 相对路径取 basename（用于 FileCard 展示；操作仍走原始 key/path） */
function toBaseName(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

export function FolderBrowser() {
  const activeType = useFileDataStore((s) => s.activeType);
  const bucketCount = useFileDataStore(
    (s) => s.buckets[s.activeType]?.items.length
  );
  const { path, entries, loading, error, navigate, refresh } =
    useBrowserStore();

  const [promptOpen, setPromptOpen] = useState(false);
  const [promptMode, setPromptMode] = useState<"mkdir" | "rename">("mkdir");
  const [renameTarget, setRenameTarget] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevCount = useRef<number | undefined>(undefined);

  // 首次挂载 / 切换类型：回到该类型根目录
  useEffect(() => {
    useBrowserStore.getState().reset();
  }, [activeType]);

  // 监听 data store 变化（FileCard 内删除/编辑会更新桶数据），变化后刷新目录
  useEffect(() => {
    if (prevCount.current !== undefined && prevCount.current !== bucketCount) {
      refresh();
    }
    prevCount.current = bucketCount;
  }, [bucketCount, refresh]);

  const segments = useMemo(() => (path ? path.split("/") : []), [path]);

  const dirEntries = entries.filter((e) => e.kind === "dir");
  const fileEntries = entries.filter((e) => e.kind === "file");

  const openMkdir = () => {
    setPromptMode("mkdir");
    setPromptOpen(true);
  };

  const openRename = (name: string) => {
    setPromptMode("rename");
    setRenameTarget(name);
    setPromptOpen(true);
  };

  const handlePromptSubmit = async (value: string) => {
    try {
      if (promptMode === "mkdir") {
        const target = path ? `${path}/${value}` : value;
        await mkdirBrowser(activeType, target);
        toast.success(`已创建文件夹「${value}」`);
      } else {
        const from = path ? `${path}/${renameTarget}` : renameTarget;
        const to = path ? `${path}/${value}` : value;
        await renameBrowser(activeType, from, to, true);
        toast.success(`已重命名为「${value}」`);
      }
      await refresh();
    } catch (e: any) {
      toast.error(e?.message || "操作失败");
      throw e;
    }
  };

  const handleDelete = async (name: string) => {
    const target = path ? `${path}/${name}` : name;
    try {
      // 先尝试空目录删除；非空时向用户确认递归删除（内容进回收站）
      try {
        await deleteBrowser(activeType, target, true);
        toast.success(`已删除文件夹「${name}」`);
      } catch (e: any) {
        const msg = String(e?.message ?? "");
        if (msg.includes("Folder not empty")) {
          const force = window.confirm(
            `文件夹「${name}」内还有内容。\n\n确定要递归删除吗？其中的文件会移入回收站，可从回收站恢复。`
          );
          if (!force) return;
          await deleteBrowser(activeType, target, true, true);
          toast.success(`已递归删除文件夹「${name}」`);
        } else {
          throw e;
        }
      }
      await refresh();
    } catch (e: any) {
      toast.error(e?.message || "删除失败");
    }
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    let ok = 0;
    let fail = 0;
    for (const file of Array.from(files)) {
      try {
        await uploadToDir(file, activeType, path);
        ok += 1;
      } catch (e: any) {
        fail += 1;
        console.error("[FolderBrowser] upload failed:", file.name, e);
      }
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (ok)
      toast.success(`已上传 ${ok} 个文件${fail ? `，${fail} 个失败` : ""}`);
    else if (fail) toast.error(`上传失败（${fail} 个文件）`);
    await refresh();
  };

  return (
    <div className="space-y-6">
      {/* 工具栏：面包屑 + 操作 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav
          aria-label="文件夹路径"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm"
        >
          <button
            onClick={() => navigate("")}
            className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 font-semibold text-foreground transition-colors hover:bg-secondary/40 hover:text-primary"
          >
            <Home className="h-4 w-4" />
            {TYPE_LABELS[activeType] ?? activeType}
          </button>
          {segments.map((seg, i) => {
            const isLast = i === segments.length - 1;
            const target = segments.slice(0, i + 1).join("/");
            return (
              <span key={target} className="flex shrink-0 items-center gap-1">
                <ChevronRight className="h-3.5 w-3.5 text-foreground/30" />
                <button
                  onClick={() => !isLast && navigate(target)}
                  className={
                    isLast
                      ? "max-w-48 truncate px-2 py-1 font-semibold text-primary"
                      : "max-w-48 truncate rounded-lg px-2 py-1 text-foreground/70 transition-colors hover:bg-secondary/40 hover:text-foreground"
                  }
                  title={seg}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={openMkdir}
            className="h-9 gap-1.5 rounded-xl border border-primary/30 bg-primary/10 px-3 text-primary hover:bg-primary/20 hover:text-primary"
          >
            <FolderPlus className="h-4 w-4" />
            <span className="hidden sm:inline">新建文件夹</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="h-9 gap-1.5 rounded-xl border border-glass-border bg-secondary/20 px-3 text-foreground/80 hover:bg-secondary/40 hover:text-foreground"
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">
              {uploading ? "上传中..." : "上传"}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={refresh}
            disabled={loading}
            title="刷新"
            className="h-9 w-9 rounded-xl text-foreground/60 hover:bg-secondary/40 hover:text-foreground"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <ViewModeToggle />
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => handleUpload(e.target.files)}
      />

      {/* 内容区 */}
      {error ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-foreground/60">
          <CircleAlert className="h-10 w-10 text-destructive/70" />
          <p className="text-sm">{error}</p>
          <Button
            onClick={refresh}
            variant="outline"
            size="sm"
            className="rounded-xl border-glass-border"
          >
            重试
          </Button>
        </div>
      ) : loading && entries.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-primary/60" />
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-foreground/50">
          <FolderX className="h-12 w-12 text-foreground/25" />
          <p className="text-sm">
            {path
              ? "此文件夹为空，上传文件或新建子文件夹"
              : "暂无内容，新建文件夹或直接上传文件"}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={openMkdir}
              variant="outline"
              className="rounded-xl border-primary/30 text-primary hover:bg-primary/10 hover:text-primary"
            >
              <FolderPlus className="mr-1.5 h-4 w-4" /> 新建文件夹
            </Button>
            <Button
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-xl bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Upload className="mr-1.5 h-4 w-4" /> 上传文件
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {dirEntries.length > 0 && (
            <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
              {dirEntries.map((e) =>
                e.kind === "dir" ? (
                  <FolderCard
                    key={`dir-${e.name}`}
                    name={e.name}
                    uploadedAt={e.uploadedAt}
                    onOpen={() => navigate(path ? `${path}/${e.name}` : e.name)}
                    onRename={() => openRename(e.name)}
                    onDelete={() => handleDelete(e.name)}
                  />
                ) : null
              )}
            </div>
          )}
          {fileEntries.length > 0 && (
            <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
              {fileEntries.map((e) =>
                e.kind === "file" ? (
                  <FileCard
                    key={e.item.name}
                    file={{
                      ...e.item,
                      metadata: {
                        ...e.item.metadata,
                        fileName: toBaseName(
                          e.item.metadata?.fileName ?? e.item.name
                        ),
                      },
                    }}
                  />
                ) : null
              )}
            </div>
          )}
        </div>
      )}

      <PromptDialog
        open={promptOpen}
        onOpenChange={setPromptOpen}
        title={promptMode === "mkdir" ? "新建文件夹" : "重命名文件夹"}
        label={
          promptMode === "mkdir"
            ? path
              ? `在「${path}」下创建`
              : `在「${TYPE_LABELS[activeType] ?? activeType}」下创建`
            : "输入新的文件夹名称"
        }
        defaultValue={promptMode === "rename" ? renameTarget : ""}
        submitText={promptMode === "mkdir" ? "创建" : "重命名"}
        onSubmit={handlePromptSubmit}
      />
    </div>
  );
}
