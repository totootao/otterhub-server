/**
 * 更新上传进度
 */
export function updateProgress(
  map: Record<string, number>,
  key: string,
  uploaded: number,
  total: number,
  setProgress: (v: Record<string, number>) => void
) {
  map[key] = Math.round((uploaded / total) * 100);
  setProgress({ ...map });
}

/**
 * 计算需要上传的分片索引
 * @param totalChunks 总分片数
 * @param uploadedIndices 已上传的分片索引列表
 */
export function getMissingChunkIndices(
  totalChunks: number,
  uploadedIndices: number[] = []
): number[] {
  const uploadedSet = new Set(uploadedIndices);
  const result: number[] = [];

  for (let i = 0; i < totalChunks; i++) {
    if (!uploadedSet.has(i)) result.push(i);
  }

  return result;
}

export interface ChunkRetryOptions {
  /** 首轮并发数，每轮递减（3 → 2 → 1），流控场景下逐步收敛 */
  concurrency?: number;
  /** 总轮数（含首轮），默认 3 */
  maxRounds?: number;
  /** 某轮结束后仍有失败分片时回调（即将进入下一轮重试） */
  onRoundRetry?: (nextRound: number, failedCount: number) => void;
}

/**
 * 分片上传 + 失败分片多轮自动重试。
 *
 * 与 processBatch 的关键差异：用 Promise.allSettled 隔离失败——
 * 单片失败不会中断同批其他分片和后续分片（1000 片传 900 失败 100 的场景，
 * 旧实现一片 429 就整个文件报废）。
 *
 * @returns 最终仍失败的分片索引（空数组 = 全部成功）
 */
export async function uploadChunksWithRetry(
  indices: number[],
  uploadOne: (chunkIndex: number) => Promise<void>,
  options: ChunkRetryOptions = {}
): Promise<number[]> {
  const { maxRounds = 3 } = options;
  let pending = [...indices];

  for (let round = 0; round < maxRounds && pending.length > 0; round++) {
    const concurrency = Math.max(1, (options.concurrency ?? 3) - round);
    const failed: number[] = [];

    for (let i = 0; i < pending.length; i += concurrency) {
      const batch = pending.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map((idx) => uploadOne(idx))
      );
      results.forEach((r, j) => {
        if (r.status === "rejected") failed.push(batch[j]);
      });
    }

    pending = failed;
    if (pending.length > 0 && round < maxRounds - 1) {
      options.onRoundRetry?.(round + 2, pending.length);
      // 轮间退避：2s / 4s，给 Telegram 流控窗口留恢复时间
      await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, round)));
    }
  }

  return pending;
}
