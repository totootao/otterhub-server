"use client";

import {
  Folder,
  FolderOpen,
  MoreVertical,
  Pencil,
  Trash2,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";

interface FolderCardProps {
  name: string;
  uploadedAt: number;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/** 文件夹卡片：玻璃拟态 + 翡翠绿渐变图标，风格与 FileCardGrid 一致 */
export function FolderCard({
  name,
  uploadedAt,
  onOpen,
  onRename,
  onDelete,
}: FolderCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group relative cursor-pointer overflow-hidden rounded-2xl border border-glass-border bg-card/60 backdrop-blur-sm",
        "transition-all duration-300 hover:border-primary/50 hover:bg-card/80 hover:shadow-lg hover:shadow-primary/10",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      )}
    >
      <div className="flex h-32 items-center justify-center">
        <div className="relative">
          <div className="absolute inset-0 rounded-full bg-primary/20 blur-2xl scale-150 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
          <Folder
            className="relative h-16 w-16 text-primary/80 transition-all duration-300 group-hover:scale-110 group-hover:text-primary drop-shadow-lg"
            strokeWidth={1.2}
          />
          <FolderOpen
            className="absolute inset-0 h-16 w-16 text-primary opacity-0 scale-75 transition-all duration-300 group-hover:opacity-100 group-hover:scale-110"
            strokeWidth={1.2}
          />
        </div>
      </div>

      <div className="border-t border-glass-border bg-linear-to-t from-black/10 to-transparent px-4 py-3">
        <div className="flex items-center gap-1.5">
          <p
            className="flex-1 truncate text-sm font-semibold text-foreground"
            title={name}
          >
            {name}
          </p>
          <ChevronRight className="h-4 w-4 shrink-0 text-foreground/30 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-primary" />
        </div>
        <p className="mt-0.5 text-xs text-foreground/50">
          {uploadedAt ? formatDate(uploadedAt) : "文件夹"}
        </p>
      </div>

      <div
        className="absolute right-2 top-2"
        onClick={(e) => e.stopPropagation()}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg text-foreground/50 opacity-0 backdrop-blur-md transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground bg-secondary/40 data-[state=open]:opacity-100"
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-40 rounded-xl border-glass-border"
          >
            <DropdownMenuItem onClick={onOpen} className="gap-2 rounded-lg">
              <FolderOpen className="h-4 w-4" /> 打开
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRename} className="gap-2 rounded-lg">
              <Pencil className="h-4 w-4" /> 重命名
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onDelete}
              className="gap-2 rounded-lg text-destructive focus:text-destructive"
            >
              <Trash2 className="h-4 w-4" /> 删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
