"use client";

import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTheme } from "next-themes";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  // resolvedTheme 在服务端为 undefined，客户端才为 'light' 或 'dark'
  const isHydrated = resolvedTheme !== undefined;
  const isDark = resolvedTheme === "dark";

  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              if (!isHydrated) return;
              setTheme(isDark ? "light" : "dark");
            }}
            className="h-9 w-9 text-foreground/60 hover:text-foreground hover:bg-secondary/50"
            disabled={!isHydrated}
            aria-label="切换主题"
          >
            {!isHydrated ? null : isDark ? (
              <Moon className="h-4 w-4" />
            ) : (
              <Sun className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{!isHydrated ? "切换主题" : isDark ? "深色模式" : "浅色模式"}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
