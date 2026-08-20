// functions/utils/list-cache.ts
// KV 全量列表短 TTL 缓存
//
// 背景：WebDAV PROPFIND / 网页目录浏览一次请求内会多次调用 listAllOfType
// （dirExists → listDirEntries，各自全量扫描），且客户端连续展开目录时
// 会反复触发同类型全量列表。远程 KV 场景下一次全量 = N 次 HTTP 分页请求，
// 是目录浏览的最大瓶颈。
//
// 策略：
//   - 仅对远程 KV（__isRemoteKV）启用；Cloudflare KV 绑定不缓存，避免配额语义差异
//   - TTL 内直接复用（默认 30s）
//   - 任何写操作（RemoteKV.put/delete）按 key 前缀立即失效，保证写入后立即可见
//
// 缓存 key 为列表前缀（如 "image:"），失效时删除所有被写入 key 覆盖的前缀。

interface CacheEntry {
  ts: number;
  items: any[];
}

const globalForListCache = globalThis as unknown as {
  __otterhubListCache?: Map<string, CacheEntry>;
};

const cache: Map<string, CacheEntry> =
  globalForListCache.__otterhubListCache ?? new Map();
globalForListCache.__otterhubListCache = cache;

export const LIST_CACHE_TTL_MS = 30_000;

/** 读取命中且未过期的缓存列表 */
export function getCachedList(prefix: string): any[] | null {
  const hit = cache.get(prefix);
  if (!hit) return null;
  if (Date.now() - hit.ts > LIST_CACHE_TTL_MS) {
    cache.delete(prefix);
    return null;
  }
  return hit.items;
}

/** 写入缓存 */
export function setCachedList(prefix: string, items: any[]): void {
  cache.set(prefix, { ts: Date.now(), items });
}

/**
 * 写失效：写入/删除某个 KV key 后调用。
 * 删除所有“前缀被该 key 覆盖”的缓存（缓存前缀 "image:" 被 key "image:abc" 覆盖）。
 */
export function invalidateListCache(key: string): void {
  if (cache.size === 0) return;
  for (const prefix of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(prefix);
  }
}

/** 清空全部缓存（调试/运维用） */
export function clearListCache(): void {
  cache.clear();
}
