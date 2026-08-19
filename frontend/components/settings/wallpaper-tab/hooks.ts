import { useState, useCallback, useEffect } from "react";
import { toast } from "sonner";

import { getWallpapers } from "@/lib/api";
import { WallpaperProvider } from "./types";
import { getSourceById } from "./sources";
import { UnifiedWallpaper } from "@shared/types";
import { useWallpaperStore } from "@/stores/wallpaper-store";
import { useWallpaperSessionStore } from "@/stores/wallpaper-session-store";

/**
 * 数据源与配置管理 Hook
 */
export function useWallpaperSources() {
  const {
    activeSourceId,
    setActiveSourceId,
    configs,
    updateConfig,
    fetchConfigsFromCloud,
    syncConfigToCloud,
  } = useWallpaperStore();

  const activeSource = getSourceById(activeSourceId);

  const hasApiKey = !!(
    activeSource &&
    configs[activeSourceId] &&
    (activeSource as any).getApiKey(configs[activeSourceId])
  );

  // 初始化时：如果本地没有数据，尝试从云端同步
  useEffect(() => {
    if (Object.keys(configs).length === 0) {
      fetchConfigsFromCloud();
    }
  }, [configs, fetchConfigsFromCloud]);

  return {
    activeSourceId,
    setActiveSourceId,
    configs,
    updateConfig,
    activeSource,
    hasApiKey,
    syncToCloud: syncConfigToCloud,
    fetchFromCloud: fetchConfigsFromCloud,
  };
}

/**
 * 壁纸列表与请求管理 Hook
 * 壁纸数据存储在 sessionStorage 中，切换 tab 不会丢失。
 */
export function useWallpaperList(activeSource: WallpaperProvider, config: any) {
  const wallpapers = useWallpaperSessionStore((s) => s.wallpapers);
  const currentPage = useWallpaperSessionStore((s) => s.currentPage);
  const minPage = useWallpaperSessionStore((s) => s.minPage);
  const maxPage = useWallpaperSessionStore((s) => s.maxPage);
  const setWallpapers = useWallpaperSessionStore((s) => s.setWallpapers);
  const setCurrentPage = useWallpaperSessionStore((s) => s.setCurrentPage);
  const clearList = useWallpaperSessionStore((s) => s.clearList);

  const [loading, setLoading] = useState(false);

  const fetchWallpapers = async () => {
    if (!activeSource || !config) return;

    const apiKey = activeSource.getApiKey(config);
    if (!apiKey) {
      throw new Error("API_KEY_MISSING");
    }

    setLoading(true);
    try {
      const randomPage =
        Math.floor(Math.random() * (maxPage - minPage + 1)) + minPage;

      const data = await getWallpapers(activeSource.id, {
        ...config,
        page: randomPage,
      });

      if (data.length === 0) {
        toast.info("未找到更多壁纸");
      } else {
        setWallpapers((prev) => {
          const existingKeys = new Set(
            prev.map((wp) => `${wp.source}-${wp.id}`)
          );
          const newUnique = data.filter(
            (wp: UnifiedWallpaper) => !existingKeys.has(`${wp.source}-${wp.id}`)
          );
          return [...newUnique, ...prev];
        });
        setCurrentPage(1);
        toast.success(
          `${activeSource.name}: 新增 ${data.length} 张壁纸 (第 ${randomPage} 页)`
        );
      }
    } catch (error: any) {
      if (error.message !== "API_KEY_MISSING") {
        toast.error(error.message || "获取失败");
      }
      throw error;
    } finally {
      setLoading(false);
    }
  };

  return {
    wallpapers,
    loading,
    currentPage,
    setCurrentPage,
    fetchWallpapers,
    clearList,
  };
}
