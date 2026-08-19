"use client";

import { Shield, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useGeneralSettingsStoreClient } from "@/stores/general-store";

export function SafeModeToggle() {
  const store = useGeneralSettingsStoreClient();

  // store 为 null 表示 SSR 阶段，渲染骨架占位
  if (!store) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9 text-foreground/60"
      >
        <Shield className="h-4 w-4" />
      </Button>
    );
  }

  const { safeMode, setSafeMode } = store;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSafeMode(!safeMode)}
            className={cn(
              "h-9 w-9",
              safeMode
                ? "bg-primary/20 text-primary hover:bg-primary/30"
                : "text-foreground/60 hover:text-foreground hover:bg-secondary/50"
            )}
          >
            {safeMode ? (
              <Shield className="h-4 w-4" />
            ) : (
              <ShieldOff className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>
            {safeMode ? "安全模式开启 · NSFW 遮罩" : "安全模式关闭 · 显示全部"}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
