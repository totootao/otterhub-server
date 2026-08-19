"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";

interface PromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label?: string;
  defaultValue?: string;
  submitText?: string;
  onSubmit: (value: string) => Promise<void> | void;
}

/** 通用单值输入弹窗（新建文件夹 / 重命名共用） */
export function PromptDialog({
  open,
  onOpenChange,
  title,
  label,
  defaultValue = "",
  submitText = "确定",
  onSubmit,
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      setSubmitting(false);
    }
  }, [open, defaultValue]);

  const handleSubmit = async () => {
    const v = value.trim();
    if (!v || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(v);
      onOpenChange(false);
    } catch (e: any) {
      // 错误提示由调用方 toast 处理
      console.error("[PromptDialog] submit failed:", e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md border-glass-border bg-popover/95 backdrop-blur-2xl">
        <DialogHeader>
          <DialogTitle className="text-foreground">{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 py-1">
          {label && <p className="text-xs text-foreground/50">{label}</p>}
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="输入名称..."
            className="h-11 border-glass-border bg-secondary/30 rounded-xl focus-visible:ring-primary/40"
          />
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="rounded-xl text-foreground/70"
          >
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!value.trim() || submitting}
            className="rounded-xl bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {submitting && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {submitText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
