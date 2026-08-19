// functions/utils/remote-kv.ts
// 自托管远程 KV 适配器
// 背景：Cloudflare KV 免费版每日写入配额有限（1000 次/天），耗尽后上传/元数据更新全部失败。
// 方案：当配置了 KV_ENDPOINT + KV_AUTH_TOKEN 时，用本适配器整体替换 c.env.oh_file_url，
//       通过 HTTP 调用自建 KV 服务（SQLite 后端，接口兼容 Cloudflare KVNamespace）。
// 服务端接口约定（见自建 kv_server.py）：
//   GET    /kv?prefix=&limit=&cursor=   → { keys:[{name,metadata,expiration}], list_complete, cursor }
//   GET    /kv/<key>?metadata=true      → { value, metadata }（404 表示不存在）
//   PUT    /kv/<key>                    body=值  头 X-KV-Metadata / X-KV-ExpirationTtl
//   DELETE /kv/<key>                    → 204（幂等）
//   GET    /kv/<key>/metadata           → { metadata }
// 二进制兼容：自建服务以 UTF-8 TEXT 存储，无法直接存任意二进制（分片暂存流）。
//           这里对二进制值统一 base64 编码并加前缀标记，读取时还原，服务端无需改动。

const B64_PREFIX = "otterhub-b64:";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 判断字符串是否为 b64 标记值 */
function isB64Value(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(B64_PREFIX);
}

// ---- 元数据编码 ----
// HTTP 头按 ISO-8859-1 传输，直接放中文会产生 mojibake。
// 这里对 metadata 做两层包装：JSON.stringify(encodeURIComponent(JSON))，
// 得到纯 ASCII 的合法 JSON 字符串，自建服务端 json.loads 可直接还原为编码串，
// 读取端再对称解码。服务端代码无需任何改动。

const ENCODED_META_PREFIX = "%";

function encodeMetadataHeader(metadata: unknown): string {
  return JSON.stringify(encodeURIComponent(JSON.stringify(metadata)));
}

/** 还原服务端返回的 metadata（兼容已编码串 / 原始 JSON 对象两种形态） */
function decodeMetadata<T = unknown>(raw: unknown): T {
  if (typeof raw === "string" && raw.startsWith(ENCODED_META_PREFIX)) {
    try {
      return JSON.parse(decodeURIComponent(raw)) as T;
    } catch {
      return null as any;
    }
  }
  return raw as T;
}

export class RemoteKV {
  constructor(
    private readonly base: string,
    private readonly token: string
  ) {}

  private url(pathAndQuery: string): string {
    return `${this.base}${pathAndQuery}`;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      ...(extra ?? {}),
    };
  }

  private static encodeKey(key: string): string {
    return encodeURIComponent(key);
  }

  // ---- KVNamespace 兼容接口 ----

  /**
   * 读取值。
   * options === "stream" 时返回 ReadableStream（供分片暂存读取 streamToBlob 使用）
   * 其余情况返回字符串（b64 标记值还原为 Uint8Array）
   */
  async get(key: string, options?: any): Promise<any> {
    const res = await fetch(this.url(`/kv/${RemoteKV.encodeKey(key)}`), {
      headers: this.authHeaders(),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`[RemoteKV] get(${key}) failed: HTTP ${res.status}`);
    }
    const text = await res.text();
    if (isB64Value(text)) {
      const bytes = base64ToBytes(text.slice(B64_PREFIX.length));
      if (options === "stream") return new Response(bytes).body;
      return bytes;
    }
    if (options === "stream") return new Response(text).body;
    return text;
  }

  /** 读取值 + 元数据（list 路由、meta 路由、进度查询等大量使用） */
  async getWithMetadata<T = unknown>(
    key: string
  ): Promise<{ value: any; metadata: T }> {
    const res = await fetch(
      this.url(`/kv/${RemoteKV.encodeKey(key)}?metadata=true`),
      { headers: this.authHeaders() }
    );
    if (res.status === 404) return { value: null, metadata: null as any };
    if (!res.ok) {
      throw new Error(
        `[RemoteKV] getWithMetadata(${key}) failed: HTTP ${res.status}`
      );
    }
    const data = (await res.json()) as { value: any; metadata: T };
    let value = data.value;
    if (isB64Value(value)) {
      value = base64ToBytes(value.slice(B64_PREFIX.length));
    }
    return { value, metadata: decodeMetadata<T>(data.metadata) };
  }

  /**
   * 写入值。value 支持 string / ReadableStream / Blob / Uint8Array / ArrayBuffer。
   * 非字符串值 base64 编码暂存；metadata 走 X-KV-Metadata 头；TTL 走 X-KV-ExpirationTtl 头。
   */
  async put(key: string, value: any, options?: any): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
    };
    if (options?.metadata !== undefined && options?.metadata !== null) {
      headers["X-KV-Metadata"] = encodeMetadataHeader(options.metadata);
    }
    if (options?.expirationTtl) {
      headers["X-KV-ExpirationTtl"] = String(Math.floor(options.expirationTtl));
    }

    let body: string;
    if (typeof value === "string") {
      body = value;
    } else if (value instanceof ReadableStream) {
      const buf = await new Response(value).arrayBuffer();
      body = B64_PREFIX + bytesToBase64(new Uint8Array(buf));
    } else if (value instanceof Blob) {
      const buf = await value.arrayBuffer();
      body = B64_PREFIX + bytesToBase64(new Uint8Array(buf));
    } else if (value instanceof ArrayBuffer) {
      body = B64_PREFIX + bytesToBase64(new Uint8Array(value));
    } else if (value instanceof Uint8Array) {
      body = B64_PREFIX + bytesToBase64(value);
    } else {
      body = String(value);
    }

    const res = await fetch(this.url(`/kv/${RemoteKV.encodeKey(key)}`), {
      method: "PUT",
      headers: this.authHeaders(headers),
      body,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `[RemoteKV] put(${key}) failed: HTTP ${res.status} ${errText.slice(0, 200)}`
      );
    }
  }

  async delete(key: string): Promise<void> {
    const res = await fetch(this.url(`/kv/${RemoteKV.encodeKey(key)}`), {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`[RemoteKV] delete(${key}) failed: HTTP ${res.status}`);
    }
  }

  /** 前缀列举（自动跟随游标翻页由调用方控制，这里单次返回） */
  async list(options?: any): Promise<{
    keys: { name: string; metadata?: any; expiration?: number }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    const params = new URLSearchParams();
    if (options?.prefix) params.set("prefix", String(options.prefix));
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", String(options.cursor));
    const qs = params.toString();
    const res = await fetch(this.url(`/kv${qs ? `?${qs}` : ""}`), {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(
        `[RemoteKV] list(${options?.prefix ?? ""}) failed: HTTP ${res.status}`
      );
    }
    const data = (await res.json()) as {
      keys: { name: string; metadata?: any; expiration?: number }[];
      list_complete: boolean;
      cursor?: string;
    };
    return {
      keys: (data.keys ?? []).map((k) => ({
        ...k,
        metadata: decodeMetadata(k.metadata),
      })),
      list_complete: !!data.list_complete,
      cursor: data.cursor || undefined,
    };
  }
}

// ---- 单例管理（跨请求复用连接配置） ----

const globalForRemoteKV = globalThis as unknown as {
  __otterhubRemoteKV?: RemoteKV;
  __otterhubRemoteKVKey?: string;
};

/**
 * 根据 env 解析远程 KV 实例（全局单例）。
 * 未配置 KV_ENDPOINT / KV_AUTH_TOKEN 时返回 null（继续使用 Cloudflare KV 绑定）。
 * KV_ENDPOINT 为完整 base URL（如 https://w.totootao.top/tekv）；
 * 若仅填 origin（如 https://w.totootao.top），可用 KV_BASE_PATH 补充路径（如 /tekv）。
 */
export function resolveRemoteKV(env: any): RemoteKV | null {
  const endpoint = env?.KV_ENDPOINT;
  const token = env?.KV_AUTH_TOKEN;
  if (!endpoint || !token) return null;

  let base = String(endpoint).replace(/\/+$/, "");
  const basePath = env.KV_BASE_PATH
    ? String(env.KV_BASE_PATH).replace(/^\/+|\/+$/g, "")
    : "";
  if (basePath && !base.endsWith(basePath)) {
    base += "/" + basePath;
  }

  const cacheKey = `${base}::${token}`;
  if (
    globalForRemoteKV.__otterhubRemoteKV &&
    globalForRemoteKV.__otterhubRemoteKVKey === cacheKey
  ) {
    return globalForRemoteKV.__otterhubRemoteKV;
  }
  const instance = new RemoteKV(base, String(token));
  // 实例标记：供 DBAdapterFactory 区分 KV 后端（避免依赖可被压缩的类名）
  (instance as any).__isRemoteKV = true;
  globalForRemoteKV.__otterhubRemoteKV = instance;
  globalForRemoteKV.__otterhubRemoteKVKey = cacheKey;
  return instance;
}
