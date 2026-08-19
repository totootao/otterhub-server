import { create } from "zustand";
import { BrowserEntry, listBrowserDir } from "@/lib/api/browser";
import { useFileDataStore } from "./data";

// ==========================================
// 文件夹浏览状态（与 WebDAV 目录模型对齐）
// path 为相对当前 activeType 的路径，"" 表示类型根目录
// 数据源是 /file/browser/list（每次导航全量拉取，个人网盘量级下足够）
// ==========================================

interface BrowserState {
  path: string;
  entries: BrowserEntry[];
  loading: boolean;
  error: string | null;

  /** 导航到指定目录（相对路径，"" 为根） */
  navigate: (path: string) => Promise<void>;
  /** 重新拉取当前目录 */
  refresh: () => Promise<void>;
  /** 返回上一级 */
  goUp: () => Promise<void>;
  /** 类型切换时回到根目录 */
  reset: () => Promise<void>;
}

export const useBrowserStore = create<BrowserState>()((set, get) => ({
  path: "",
  entries: [],
  loading: false,
  error: null,

  navigate: async (path) => {
    const type = useFileDataStore.getState().activeType;
    set({ path, loading: true, error: null });
    try {
      const { entries } = await listBrowserDir(type, path);
      set({ entries, loading: false });
    } catch (e: any) {
      set({ loading: false, error: e?.message ?? "加载失败" });
    }
  },

  refresh: async () => {
    await get().navigate(get().path);
  },

  goUp: async () => {
    const { path } = get();
    if (!path) return;
    const idx = path.lastIndexOf("/");
    await get().navigate(idx === -1 ? "" : path.slice(0, idx));
  },

  reset: async () => {
    await get().navigate("");
  },
}));
