// functions/utils/cache.ts

export const CACHE_CONFIG = {
  file: { maxAge: 86400 * 7 }, // 7 天
  thumb: { maxAge: 86400 * 1 }, // 1 天
  api: { maxAge: 3600 },        // 1 小时
} as const;

const CACHE_NAME = 'otterhub-cache';
const INTERNAL_CACHE_ORIGIN = 'https://otterhub.internal';

// 懒加载 Cache 实例，避免重复代码
const getCache = () => caches.open(CACHE_NAME);

/**
 * 统一处理 Cache Key，支持 Request 或 URL 字符串，强制转换为 GET 请求
 */
export const createCacheKey = (reqOrUrl: Request | string): Request => {
  const url = typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl.url;
  return new Request(url, { method: 'GET' });
};

export const createNamespacedCacheKey = (namespace: string, key: string) => 
  createCacheKey(`${INTERNAL_CACHE_ORIGIN}/${namespace}/${encodeURIComponent(key)}`);

// ==========================================
// 标准 HTTP 响应缓存
// ==========================================

export async function getFromCache(request: Request): Promise<Response | null> {
  const result = await (await getCache()).match(createCacheKey(request));
  return result ?? null;
}

export async function putToCache(request: Request, response: Response, type: keyof typeof CACHE_CONFIG) {
  // 忽略非成功状态和 Cache API 不支持的 206 状态
  if (!response.ok || response.status === 206) return;

  // 必须解构创建全新的 Response 对象，因为原始 response.headers 是不可变 (immutable) 的
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Cache-Control", `public, max-age=${CACHE_CONFIG[type].maxAge}`);

  const cachedResp = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });

  await (await getCache()).put(createCacheKey(request), cachedResp);
}

export async function deleteCache(request: Request) {
  await (await getCache()).delete(createCacheKey(request));
}

export async function deleteFileCache(origin: string, key: string) {
  await (await getCache()).delete(createCacheKey(`${origin}/file/${key}`));
}

// ==========================================
// 内部纯文本/KV 缓存
// ==========================================

export async function getTextFromCache(namespace: string, key: string): Promise<string | null> {
  const cached = await (await getCache()).match(createNamespacedCacheKey(namespace, key));
  return cached ? cached.text() : null;
}

export async function putTextToCache(namespace: string, key: string, value: string, maxAge: number): Promise<void> {
  await (await getCache()).put(
    createNamespacedCacheKey(namespace, key),
    new Response(value, {
      headers: { "Cache-Control": `public, max-age=${maxAge}` },
    })
  );
}