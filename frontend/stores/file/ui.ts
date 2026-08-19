import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useFileDataStore } from "./data";
import { ViewMode, SortType, SortOrder } from "@/lib/types";
import { FileType } from "@shared/types";
import { storeKey } from "..";
import { useMemo } from "react";

interface FileUIState {
  viewMode: ViewMode;
  /** 文件夹模式之外最近一次视图（头部 Logo 切回时恢复） */
  lastNonFolderViewMode: ViewMode;
  itemsPerPage: number;
  currentPage: number;
  sortType: SortType;
  sortOrder: SortOrder;
  fabPosition: { x: number; y: number };

  // selection 按桶管理
  selectedKeys: Record<FileType, string[]>;

  // 强制加载的文件（不持久化）
  forceLoadFiles: string[];

  // Actions
  setViewMode: (mode: ViewMode) => void;
  setItemsPerPage: (count: number) => void;
  setCurrentPage: (page: number) => void;
  setSortType: (type: SortType) => void;
  setSortOrder: (order: SortOrder) => void;
  setFabPosition: (position: { x: number; y: number }) => void;

  toggleSelection: (name: string, type?: FileType) => void;
  selectAll: (names?: string[], type?: FileType) => void;
  addSelection: (names: string[], type?: FileType) => void;
  removeSelection: (names: string[], type?: FileType) => void;
  clearSelection: (type?: FileType) => void;
  addForceLoadFile: (name: string) => void;
}

export const useFileUIStore = create<FileUIState>()(
  persist(
    (set, _get) => ({
      viewMode: ViewMode.Grid,
      lastNonFolderViewMode: ViewMode.Grid,
      itemsPerPage: 20,
      currentPage: 0,
      sortType: SortType.UploadedAt,
      sortOrder: SortOrder.Desc,
      fabPosition: { x: 32, y: 32 },

      selectedKeys: {
        [FileType.Image]: [],
        [FileType.Audio]: [],
        [FileType.Video]: [],
        [FileType.Document]: [],
        [FileType.Trash]: [],
      },

      forceLoadFiles: [],

      setViewMode: (mode) => {
        // 切换视图模式时重置页码；同步记录文件夹模式外的最近视图
        set((state) => ({
          viewMode: mode,
          currentPage: 0,
          lastNonFolderViewMode:
            mode !== ViewMode.Folder ? mode : state.lastNonFolderViewMode,
        }));
      },

      setItemsPerPage: (count) => {
        set({ itemsPerPage: count, currentPage: 0 }); // 更改每页数量时重置页码
      },

      setCurrentPage: (page) => set({ currentPage: page }),

      setSortType: (type) => set({ sortType: type }),
      setSortOrder: (order) => set({ sortOrder: order }),
      setFabPosition: (position) => set({ fabPosition: position }),

      toggleSelection: (name, type) =>
        set((state) => {
          const currentType = type ?? useFileDataStore.getState().activeType;
          const current = state.selectedKeys[currentType] || [];
          const isSelected = current.includes(name);
          return {
            selectedKeys: {
              ...state.selectedKeys,
              [currentType]: isSelected
                ? current.filter((key) => key !== name)
                : [...current, name],
            },
          };
        }),

      selectAll: (names, type) =>
        set((state) => {
          const currentType = type ?? useFileDataStore.getState().activeType;
          const keys =
            names ??
            useFileDataStore
              .getState()
              .buckets[currentType].items.map((i) => i.name);
          return {
            selectedKeys: {
              ...state.selectedKeys,
              [currentType]: keys,
            },
          };
        }),

      addSelection: (names, type) =>
        set((state) => {
          const currentType = type ?? useFileDataStore.getState().activeType;
          const current = state.selectedKeys[currentType] || [];
          const newSet = new Set(current);
          names.forEach((name) => newSet.add(name));
          return {
            selectedKeys: {
              ...state.selectedKeys,
              [currentType]: Array.from(newSet),
            },
          };
        }),

      removeSelection: (names, type) =>
        set((state) => {
          const currentType = type ?? useFileDataStore.getState().activeType;
          const current = state.selectedKeys[currentType] || [];
          const toRemove = new Set(names);
          return {
            selectedKeys: {
              ...state.selectedKeys,
              [currentType]: current.filter((key) => !toRemove.has(key)),
            },
          };
        }),

      clearSelection: (type) =>
        set((state) => {
          const currentType = type ?? useFileDataStore.getState().activeType;
          return {
            selectedKeys: {
              ...state.selectedKeys,
              [currentType]: [],
            },
          };
        }),

      addForceLoadFile: (name) =>
        set((state) => ({
          forceLoadFiles: [...state.forceLoadFiles, name],
        })),
    }),
    {
      name: storeKey.FileUI,
      partialize: (state) => ({
        viewMode: state.viewMode,
        itemsPerPage: state.itemsPerPage,
        sortType: state.sortType,
        sortOrder: state.sortOrder,
        fabPosition: state.fabPosition,
      }),
      // lastNonFolderViewMode 不持久化：恢复时若 viewMode 非文件夹模式则同步之
      onRehydrateStorage: () => (state) => {
        if (state && state.viewMode !== ViewMode.Folder) {
          useFileUIStore.setState({ lastNonFolderViewMode: state.viewMode });
        }
      },
    }
  )
);

export const useActiveSelectedKeys = () => {
  const activeType = useFileDataStore((s) => s.activeType);
  const selectedKeys = useFileUIStore((s) => s.selectedKeys);
  return selectedKeys[activeType] || [];
};

// ========== 跨类型批量操作 Hooks ==========

/** 获取所有类型中选中的 key */
export const useTotalSelectedKeys = () => {
  const selectedKeys = useFileUIStore((s) => s.selectedKeys);
  return useMemo(() => Object.values(selectedKeys).flat(), [selectedKeys]);
};

/** 获取所有类型中选中的总数 */
export const useTotalSelectedCount = () => {
  const selectedKeys = useFileUIStore((s) => s.selectedKeys);
  return useMemo(
    () => Object.values(selectedKeys).flat().length,
    [selectedKeys]
  );
};

/** 检查是否有任何选中的文件 */
export const useHasAnySelection = () => {
  const selectedKeys = useFileUIStore((s) => s.selectedKeys);
  return useMemo(
    () => Object.values(selectedKeys).some((keys) => keys.length > 0),
    [selectedKeys]
  );
};

/** 按类型分组的选中统计 */
export const useSelectedStats = () => {
  const selectedKeys = useFileUIStore((s) => s.selectedKeys);
  return useMemo(
    () =>
      Object.entries(selectedKeys)
        .map(([type, keys]) => ({
          type: type as FileType,
          count: (keys as string[]).length,
        }))
        .filter((s) => s.count > 0),
    [selectedKeys]
  );
};

/** 清空所有类型的选中 */
export const clearAllSelection = () => {
  useFileUIStore.setState({
    selectedKeys: {
      [FileType.Image]: [],
      [FileType.Audio]: [],
      [FileType.Video]: [],
      [FileType.Document]: [],
      [FileType.Trash]: [],
    },
  });
};

/** 从所有类型中移除指定的 keys */
export const removeSelectionFromAllTypes = (keysToRemove: string[]) => {
  const keysSet = new Set(keysToRemove);
  useFileUIStore.setState((state) => ({
    selectedKeys: Object.entries(state.selectedKeys).reduce(
      (acc, [type, keys]) => {
        acc[type as FileType] = keys.filter((key) => !keysSet.has(key));
        return acc;
      },
      {} as Record<FileType, string[]>
    ),
  }));
};
