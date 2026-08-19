"use client";

import {
  Download,
  Trash2,
  X,
  Toolbox,
  Check,
  Tag,
  Copy,
  FilePen,
  Share2,
  ImageIcon,
  Music,
  Video,
  FileText,
  XIcon,
} from "lucide-react";
import { useState, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import {
  useFileDataStore,
  useFilteredFiles,
  useFileBuckets,
} from "@/stores/file";
import {
  useFileUIStore,
  useActiveSelectedKeys,
  useTotalSelectedKeys,
  useSelectedStats,
  clearAllSelection,
  removeSelectionFromAllTypes,
} from "@/stores/file";
import {
  getFileDownloadUrl,
  getFileUrl,
  moveToTrash,
  deleteFile,
} from "@/lib/api";
import {
  downloadFile,
  downloadFiles,
  getFileTypeFromKey,
  processBatch,
  type DirectoryHandleResult,
} from "@/lib/utils";
import { ViewMode } from "@/lib/types";
import { BatchEditTagsDialog } from "./BatchEditTagsDialog";
import { BatchRenameDialog } from "./BatchRenameDialog";
import { BatchShareDialog } from "./BatchShareDialog";
import { MobileBatchDownloadDialog } from "./MobileBatchDownloadDialog";
import { DownloadDirectoryGuide } from "@/components/download/DownloadDirectoryGuide";
import { toast } from "sonner";
import {
  FileMetadata,
  FileTag,
  FileType,
  MAX_FILES_IN_BUNDLE,
} from "@shared/types";
import { isMobileBrowser } from "@/hooks/use-mobile";

// 文件类型图标映射
const typeIcons: Record<FileType, typeof ImageIcon> = {
  [FileType.Image]: ImageIcon,
  [FileType.Audio]: Music,
  [FileType.Video]: Video,
  [FileType.Document]: FileText,
  [FileType.Trash]: Trash2,
};

// 文件类型名称映射
const typeNames: Record<FileType, string> = {
  [FileType.Image]: "图片",
  [FileType.Audio]: "音频",
  [FileType.Video]: "视频",
  [FileType.Document]: "文档",
  [FileType.Trash]: "回收站",
};

export function BatchOperationsBar() {
  const { activeType, updateFileMetadata, moveToTrashLocal, deleteFilesLocal } =
    useFileDataStore();

  const {
    clearSelection,
    addSelection,
    removeSelection,
    viewMode,
    currentPage,
    itemsPerPage,
  } = useFileUIStore();

  // ===== 跨类型选中管理 =====
  const activeSelectedKeys = useActiveSelectedKeys();
  const totalSelectedKeys = useTotalSelectedKeys();
  const selectedStats = useSelectedStats();
  const buckets = useFileBuckets();

  const [showBatchTags, setShowBatchTags] = useState(false);
  const [showBatchRename, setShowBatchRename] = useState(false);
  const [showBatchShare, setShowBatchShare] = useState(false);
  const [showDirGuide, setShowDirGuide] = useState(false);
  const [showMobileBatchDownload, setShowMobileBatchDownload] = useState(false);
  const [mobileDownloadFiles, setMobileDownloadFiles] = useState<
    Array<{
      key: string;
      metadata: FileMetadata;
      fileType: FileType;
    }>
  >([]);
  const [pendingDownloadFiles, setPendingDownloadFiles] = useState<Array<{
    key: string;
    metadata: FileMetadata;
  }> | null>(null);

  const filteredFiles = useFilteredFiles();

  // ===== 跨类型文件数据 =====
  // 获取所有类型的文件并构建 Map
  const allItems = useMemo(() => {
    return Object.values(buckets).flatMap((bucket) => bucket.items);
  }, [buckets]);

  const allItemMap = useMemo(() => {
    return new Map(allItems.map((f) => [f.name, f]));
  }, [allItems]);

  // 获取所有选中的文件（跨类型）
  const selectedItems = useMemo(() => {
    return totalSelectedKeys
      .map((key) => allItemMap.get(key))
      .filter(Boolean) as typeof allItems;
  }, [totalSelectedKeys, allItemMap]);

  // 当前类型的选中统计
  const currentCount = activeSelectedKeys.length;
  const totalCount = totalSelectedKeys.length;
  const hasCrossTypeSelection = totalCount > currentCount;

  /** ===== 派生数据 ===== */
  // 当前页显示的文件
  const currentFiles = useMemo(() => {
    if (viewMode === ViewMode.Masonry) return filteredFiles;
    const offset = currentPage * itemsPerPage;
    return filteredFiles.slice(offset, offset + itemsPerPage);
  }, [filteredFiles, viewMode, currentPage, itemsPerPage]);

  const activeSelectedSet = useMemo(
    () => new Set(activeSelectedKeys),
    [activeSelectedKeys]
  );

  const isAllSelected =
    currentFiles.length > 0 &&
    currentFiles.every((file) => activeSelectedSet.has(file.name));

  /** ===== 批量标签成功回调 ===== */
  const handleBatchTagSuccess = (
    updatedFiles: Array<{ name: string; tags: FileTag[] }>
  ) => {
    updatedFiles.forEach(({ name, tags }) => {
      const file = allItemMap.get(name);
      if (!file) return;

      updateFileMetadata(name, {
        ...file.metadata,
        tags,
      });
    });
  };

  /** ===== 批量重命名成功回调 ===== */
  const handleBatchRenameSuccess = (
    updatedFiles: Array<{ name: string; fileName: string }>
  ) => {
    updatedFiles.forEach(({ name, fileName }) => {
      const file = allItemMap.get(name);
      if (!file) return;

      updateFileMetadata(name, {
        ...file.metadata,
        fileName,
      });
    });
  };

  /** ===== 开始批量下载 ===== */
  const startBatchDownload = async (
    files: Array<{ key: string; metadata: FileMetadata }>,
    dirHandleResult?: DirectoryHandleResult
  ) => {
    const toastId = toast.loading(`准备下载 ${files.length} 个文件...`);
    let downloadDirName: string | null = null;

    try {
      const downloadOptions = {
        files,
        getUrl: getFileDownloadUrl,
        onDirectorySelected: (dirName: string) => {
          downloadDirName = dirName;
          toast.loading(`正在下载到 ${dirName}...`, { id: toastId });
        },
        onDirectoryReused: (dirName: string) => {
          downloadDirName = dirName;
          toast.loading(`正在下载到 ${dirName}...`, { id: toastId });
        },
        onFileStart: (index: number, fileName: string) => {
          const prefix = downloadDirName
            ? `下载到 ${downloadDirName}`
            : "下载中";
          toast.loading(
            `${prefix} (${index + 1}/${files.length}): ${fileName}`,
            {
              id: toastId,
            }
          );
        },
        onFileComplete: (index: number, fileName: string, success: boolean) => {
          if (!success) {
            toast.error(`下载失败: ${fileName}`, { duration: 2000 });
          }
        },
      };

      const result = dirHandleResult
        ? await downloadFiles({ ...downloadOptions, dirHandleResult })
        : await downloadFiles(downloadOptions);

      if (result.cancelled > 0) {
        toast.info(`下载已取消`, { id: toastId });
      } else if (result.failed === 0) {
        toast.success(`成功下载 ${result.success} 个文件`, { id: toastId });
      } else {
        toast.warning(`部分文件下载失败`, {
          id: toastId,
          description: `成功 ${result.success} 个，失败 ${result.failed} 个`,
        });
      }
    } catch (error) {
      if (error instanceof Error && error.message === "NO_DIRECTORY_HANDLE") {
        // 需要显示引导弹窗
        toast.dismiss(toastId);
        setPendingDownloadFiles(files);
        setShowDirGuide(true);
      } else {
        toast.error("批量下载失败", { id: toastId });
      }
    }
  };

  /** ===== 处理目录选择 ===== */
  const handleDirectorySelected = async (dirResult: DirectoryHandleResult) => {
    setShowDirGuide(false);

    if (!pendingDownloadFiles) return;

    await startBatchDownload(pendingDownloadFiles, dirResult);
    setPendingDownloadFiles(null);
  };

  /** ===== 批量下载（跨类型） ===== */
  const handleBatchDownload = async () => {
    if (totalSelectedKeys.length === 0) return;

    const files = totalSelectedKeys
      .map((key) => {
        const file = allItemMap.get(key);
        if (!file) return null;
        return {
          key,
          metadata: file.metadata,
          fileType: getFileTypeFromKey(key),
        };
      })
      .filter(Boolean) as Array<{
      key: string;
      metadata: FileMetadata;
      fileType: FileType;
    }>;

    if (files.length === 1) {
      const [{ key, metadata }] = files;
      const toastId = toast.loading(`准备下载: ${metadata.fileName}`);

      try {
        const result = await downloadFile(
          getFileDownloadUrl(key),
          metadata,
          (progress) => {
            const message = progress.dirName
              ? `下载到 ${progress.dirName}: ${metadata.fileName} (${progress.percentage}%)`
              : `下载中: ${metadata.fileName} (${progress.percentage}%)`;
            toast.loading(message, { id: toastId });
          }
        );
        if (result.status === "cancelled") {
          toast.dismiss(toastId);
          return;
        }
        const message = result.dirName
          ? `下载完成: ${metadata.fileName}，已保存到 ${result.dirName}`
          : `下载完成: ${metadata.fileName}`;
        toast.success(message, { id: toastId });
      } catch (_error) {
        toast.error(`下载失败: ${metadata.fileName}`, { id: toastId });
      }
      return;
    }

    if (files.length > MAX_FILES_IN_BUNDLE) {
      toast.error(`批量下载最多支持 ${MAX_FILES_IN_BUNDLE} 个文件`);
      return;
    }

    const isMobile = isMobileBrowser();
    const canUseDirectoryPicker = "showDirectoryPicker" in window && !isMobile;

    if (!canUseDirectoryPicker) {
      setMobileDownloadFiles(files);
      setShowMobileBatchDownload(true);
      return;
    }

    // 开始批量下载（可能显示引导弹窗）
    await startBatchDownload(files);
  };

  /** ===== 批量删除（跨类型） ===== */
  const handleBatchDelete = async () => {
    // 构建确认信息，包含各类型统计
    const statsText = selectedStats
      .map((s) => `${typeNames[s.type]}:${s.count}`)
      .join("，");
    const confirmMsg = hasCrossTypeSelection
      ? `确认删除这 ${totalCount} 个文件？\n（${statsText}）`
      : `确认删除这 ${totalCount} 个文件？`;

    if (!confirm(confirmMsg)) return;

    const toastId = toast.loading(`正在删除 ${totalCount} 个文件...`);

    try {
      const successful: string[] = [];
      const failed: string[] = [];

      await processBatch(
        totalSelectedKeys,
        async (key) => {
          try {
            const success = await moveToTrash(key);
            if (success) {
              successful.push(key);
            } else {
              failed.push(key);
            }
          } catch (_err) {
            failed.push(key);
          }
        },
        (current, total) => {
          toast.loading(`正在删除 ${current}/${total} 个文件...`, {
            id: toastId,
          });
        },
        10
      );

      // 更新本地状态
      successful.forEach((key) => {
        const item = allItemMap.get(key);
        if (item) moveToTrashLocal(item);
      });

      // 从所有类型的选中中移除成功的文件
      removeSelectionFromAllTypes(successful);

      if (failed.length === 0) {
        toast.success(`成功删除 ${successful.length} 个文件`, { id: toastId });
      } else {
        toast.error(`部分文件删除失败`, {
          id: toastId,
          description: `${failed.length} 个文件删除失败，成功删除 ${successful.length} 个`,
        });
      }
    } catch (_error) {
      toast.error("操作失败", {
        id: toastId,
        description: "执行批量删除时发生未知错误",
      });
    }
  };

  /** ===== 批量彻底删除（跨类型） ===== */
  const handleBatchPermanentDelete = async () => {
    // 构建确认信息，包含各类型统计
    const statsText = selectedStats
      .map((s) => `${typeNames[s.type]}:${s.count}`)
      .join("，");
    const confirmMsg = hasCrossTypeSelection
      ? `确认【彻底删除】这 ${totalCount} 个文件？此操作不可恢复！\n（${statsText}）`
      : `确认【彻底删除】这 ${totalCount} 个文件？此操作不可恢复！`;

    if (!confirm(confirmMsg)) return;

    const toastId = toast.loading(`正在删除 ${totalCount} 个文件...`);

    try {
      const successful: string[] = [];
      const failed: string[] = [];

      await processBatch(
        totalSelectedKeys,
        async (key) => {
          try {
            const success = await deleteFile(key);
            if (success) {
              successful.push(key);
            } else {
              failed.push(key);
            }
          } catch (_err) {
            failed.push(key);
          }
        },
        (current, total) => {
          toast.loading(`正在彻底删除 ${current}/${total} 个文件...`, {
            id: toastId,
          });
        },
        10
      );

      if (successful.length > 0) {
        deleteFilesLocal(successful);
      }

      // 从所有类型的选中中移除成功的文件
      removeSelectionFromAllTypes(successful);

      if (failed.length === 0) {
        toast.success(`成功彻底删除 ${successful.length} 个文件`, {
          id: toastId,
        });
      } else {
        toast.error(`部分文件删除失败`, {
          id: toastId,
          description: `${failed.length} 个文件彻底删除失败，成功删除 ${successful.length} 个`,
        });
      }
    } catch (_error) {
      toast.error("操作失败", {
        id: toastId,
        description: "执行批量彻底删除时发生未知错误",
      });
    }
  };

  /** ===== 批量复制（跨类型） ===== */
  const handleBatchCopy = async () => {
    const urls = totalSelectedKeys
      .map((key) => {
        const file = allItemMap.get(key);
        if (!file) return null;
        return getFileUrl(key);
      })
      .filter(Boolean);

    const text = urls.join("\n");
    await navigator.clipboard.writeText(text);

    toast.success(`已复制 ${urls.length} 个文件链接`);
  };

  /** ===== 类型统计标签组件 ===== */
  const TypeBadge = ({
    type,
    count,
    onClear,
  }: {
    type: FileType;
    count: number;
    onClear?: () => void;
  }) => {
    const Icon = typeIcons[type];
    return (
      <Badge
        variant="secondary"
        className="group gap-1 bg-white/20 text-primary-foreground border-none cursor-pointer transition-colors"
        onClick={onClear}
        title={`清空选中「${typeNames[type]}」`}
      >
        <Icon className="h-3 w-3 group-hover:hidden" />
        <span className="group-hover:hidden">{count}</span>
        <XIcon className="h-3 w-3 hidden group-hover:block" />
      </Badge>
    );
  };

  /** ===== UI ===== */
  return (
    <>
      <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 animate-in slide-in-from-bottom-4 w-[calc(100%-2rem)] max-w-max">
        <div className="flex items-center gap-2 md:gap-4 rounded-full border border-glass-border bg-linear-to-r from-primary/90 to-accent/90 px-4 md:px-6 py-2.5 md:py-3 shadow-2xl backdrop-blur-xl">
          {/* 选中统计 */}
          <div className="flex items-center gap-2">
            <span className="text-xs md:text-sm font-medium text-primary-foreground whitespace-nowrap">
              选中 {totalCount} 项
            </span>
            {/* 跨类型统计标签 */}
            {selectedStats.length > 0 && (
              <div className="hidden md:flex items-center gap-1">
                {selectedStats.map(({ type, count }) => (
                  <TypeBadge
                    key={type}
                    type={type}
                    count={count}
                    onClear={() => clearSelection(type)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 md:gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="text-primary-foreground hover:bg-primary-foreground/10 px-2 md:px-3"
              onClick={handleBatchDownload}
              title="下载"
            >
              <Download className="md:mr-2 h-4 w-4" />
              <span className="hidden md:inline">下载</span>
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className="text-primary-foreground hover:bg-primary-foreground/10 px-2 md:px-3"
              onClick={handleBatchDelete}
              title="删除"
            >
              <Trash2 className="md:mr-2 h-4 w-4 text-red-400" />
              <span className="hidden md:inline">删除</span>
            </Button>

            <div className="h-6 w-px bg-primary-foreground/20 mx-1" />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-primary-foreground hover:bg-primary-foreground/10"
                >
                  <Toolbox className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>

              <DropdownMenuContent
                align="end"
                side="top"
                className="min-w-[180px] border-glass-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => {
                    const names = currentFiles.map((i) => i.name);
                    if (isAllSelected) {
                      removeSelection(names, activeType);
                    } else {
                      addSelection(names, activeType);
                    }
                  }}
                  className="cursor-pointer text-foreground hover:bg-secondary/50"
                >
                  <Check className="mr-2 h-4 w-4 text-blue-400" />
                  {isAllSelected ? "取消本页全选" : "全选当前页"}
                </DropdownMenuItem>

                <DropdownMenuItem
                  onClick={() => setShowBatchTags(true)}
                  className="cursor-pointer text-foreground hover:bg-secondary/50"
                >
                  <Tag className="mr-2 h-4 w-4 text-blue-400" />
                  编辑标签
                </DropdownMenuItem>

                <DropdownMenuItem
                  onClick={() => setShowBatchRename(true)}
                  className="cursor-pointer text-foreground hover:bg-secondary/50"
                >
                  <FilePen className="mr-2 h-4 w-4 text-blue-400" />
                  重命名
                </DropdownMenuItem>

                <DropdownMenuItem
                  onClick={() => {
                    if (totalSelectedKeys.length > MAX_FILES_IN_BUNDLE) {
                      toast.error(`最多支持 ${MAX_FILES_IN_BUNDLE} 个文件`);
                      return;
                    }
                    setShowBatchShare(true);
                  }}
                  className="cursor-pointer text-foreground hover:bg-secondary/50"
                >
                  <Share2 className="mr-2 h-4 w-4 text-blue-400" />
                  打包分享
                </DropdownMenuItem>

                <DropdownMenuItem
                  onClick={handleBatchCopy}
                  className="cursor-pointer text-foreground hover:bg-secondary/50"
                >
                  <Copy className="mr-2 h-4 w-4 text-blue-400" />
                  复制链接
                </DropdownMenuItem>

                <div className="my-1 h-px bg-border" />

                <DropdownMenuItem
                  onClick={handleBatchPermanentDelete}
                  className="cursor-pointer text-red-500 hover:bg-red-50 focus:text-red-500 focus:bg-red-50"
                >
                  <Trash2 className="mr-2 h-4 w-4 text-red-500" />
                  彻底删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              size="sm"
              variant="ghost"
              className="text-primary-foreground hover:bg-primary-foreground/10"
              onClick={clearAllSelection}
              title="清空全部选中"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <BatchEditTagsDialog
        files={selectedItems}
        open={showBatchTags}
        onOpenChange={setShowBatchTags}
        onSuccess={handleBatchTagSuccess}
      />

      <BatchRenameDialog
        files={selectedItems}
        open={showBatchRename}
        onOpenChange={setShowBatchRename}
        onSuccess={handleBatchRenameSuccess}
      />

      <BatchShareDialog
        files={selectedItems}
        open={showBatchShare}
        onOpenChange={setShowBatchShare}
      />

      <MobileBatchDownloadDialog
        files={mobileDownloadFiles}
        open={showMobileBatchDownload}
        onOpenChange={setShowMobileBatchDownload}
      />

      <DownloadDirectoryGuide
        open={showDirGuide}
        onOpenChange={setShowDirGuide}
        onDirectorySelected={handleDirectorySelected}
      />
    </>
  );
}
