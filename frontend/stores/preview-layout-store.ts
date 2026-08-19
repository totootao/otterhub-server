import { create } from "zustand";
import { persist } from "zustand/middleware";
import { PreviewType } from "./preview-store";
import { storeKey } from ".";

type PreviewBookmarkPositions = Record<PreviewType, number>;

interface PreviewLayoutState {
  bookmarkPositions: PreviewBookmarkPositions;
  setBookmarkPosition: (
    type: PreviewType,
    topRatio: number,
    visibleTypes?: PreviewType[]
  ) => void;
}

const DEFAULT_BOOKMARK_POSITIONS: PreviewBookmarkPositions = {
  audio: 0.25,
  video: 0.4,
  text: 0.55,
};

const MIN_RATIO = 0.08;
const MAX_RATIO = 0.92;
const DEFAULT_MIN_GAP_RATIO = 0.08;

/** 将位置限制在可视区域内。 */
function clampRatio(value: number) {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
}

/** 调整可见书签位置，避免相互重叠。 */
function normalizePositions(
  positions: PreviewBookmarkPositions,
  visibleTypes: PreviewType[] = []
) {
  const uniqueTypes = Array.from(new Set(visibleTypes));
  if (uniqueTypes.length <= 1) return positions;

  const sortedTypes = uniqueTypes.sort((a, b) => positions[a] - positions[b]);
  const minGap =
    typeof window === "undefined"
      ? DEFAULT_MIN_GAP_RATIO
      : Math.min(0.16, 56 / Math.max(window.innerHeight, 1));

  const next = { ...positions };

  for (let i = 0; i < sortedTypes.length; i++) {
    const type = sortedTypes[i];
    next[type] = clampRatio(next[type]);

    if (i === 0) continue;

    const previousType = sortedTypes[i - 1];
    if (next[type] - next[previousType] < minGap) {
      next[type] = next[previousType] + minGap;
    }
  }

  const lastType = sortedTypes[sortedTypes.length - 1];
  if (next[lastType] > MAX_RATIO) {
    next[lastType] = MAX_RATIO;

    for (let i = sortedTypes.length - 2; i >= 0; i--) {
      const type = sortedTypes[i];
      const nextType = sortedTypes[i + 1];
      if (next[nextType] - next[type] < minGap) {
        next[type] = next[nextType] - minGap;
      }
    }
  }

  return next;
}

/** 持久化 preview 最小化侧边书签的位置。 */
export const usePreviewLayoutStore = create<PreviewLayoutState>()(
  persist(
    (set) => ({
      bookmarkPositions: DEFAULT_BOOKMARK_POSITIONS,
      setBookmarkPosition: (type, topRatio, visibleTypes = [type]) =>
        set((state) => {
          const positions = {
            ...DEFAULT_BOOKMARK_POSITIONS,
            ...state.bookmarkPositions,
            [type]: clampRatio(topRatio),
          };

          return {
            bookmarkPositions: normalizePositions(positions, visibleTypes),
          };
        }),
    }),
    {
      name: storeKey.PreviewLayout,
    }
  )
);
