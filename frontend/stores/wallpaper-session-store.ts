import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { UnifiedWallpaper } from "@shared/types";
import { storeKey } from ".";

interface WallpaperSessionState {
  wallpapers: UnifiedWallpaper[];
  currentPage: number;
  minPage: number;
  maxPage: number;
  uploadedIds: string[];

  setWallpapers: (
    updater: (prev: UnifiedWallpaper[]) => UnifiedWallpaper[]
  ) => void;
  clearList: () => void;
  setCurrentPage: (page: number) => void;
  setMinPage: (page: number) => void;
  setMaxPage: (page: number) => void;
  addUploadedId: (id: string | number) => void;
  hasUploaded: (id: string | number) => boolean;
  reset: () => void;
}

const initialState = {
  wallpapers: [] as UnifiedWallpaper[],
  currentPage: 1,
  minPage: 1,
  maxPage: 20,
  uploadedIds: [] as string[],
};

export const useWallpaperSessionStore = create<WallpaperSessionState>()(
  persist(
    (set, get) => ({
      ...initialState,

      setWallpapers: (updater) =>
        set((state) => ({ wallpapers: updater(state.wallpapers) })),

      clearList: () => set({ wallpapers: [], currentPage: 1 }),

      setCurrentPage: (page) => set({ currentPage: page }),

      setMinPage: (page) => set({ minPage: page }),

      setMaxPage: (page) => set({ maxPage: page }),

      addUploadedId: (id) =>
        set((state) => ({
          uploadedIds: state.uploadedIds.includes(String(id))
            ? state.uploadedIds
            : [...state.uploadedIds, String(id)],
        })),

      hasUploaded: (id) => get().uploadedIds.includes(String(id)),

      reset: () => set(initialState),
    }),
    {
      name: storeKey.WallpaperSession,
      storage: createJSONStorage(() => sessionStorage),
    }
  )
);
