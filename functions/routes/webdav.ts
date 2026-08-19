import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { verifyJWT } from "@utils/auth";
import {
  FileType,
  FileMetadata,
  FileItem,
  MAX_CHUNK_SIZE,
  MAX_CHUNK_NUM,
  MAX_FILE_SIZE,
  MAX_FILENAME_LENGTH,
  MAX_PATH_LENGTH,
  chunkPrefix,
} from "@shared/types";
import { DBAdapterFactory } from "@utils/db-adapter";
import { deleteFileCache } from "@utils/cache";
import {
  buildKeyId,
  getFileExt,
  getUniqueFileId,
  getContentTypeByExt,
} from "@utils/file";
import { TEMP_CHUNK_TTL } from "types";
import type { Env } from "../types/hono";

// ==========================================
// WebDAV 服务
// 挂载于 /dav，将网盘文件暴露为标准 WebDAV 资源
// 目录结构为虚拟目录：/img /video /audio /doc 对应四种 FileType
// 认证：HTTP Basic（密码 = 登录密码 PASSWORD 或 API_TOKEN，用户名任意）
// ==========================================

const DAV_BASE = "/dav";
const REALM = "OtterHub WebDAV";
const DAV_CLASS = "1, 2";
const DAV_ALLOW =
  "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK";

export const TYPE_DIRS = [
  { dir: "img", type: FileType.Image },
  { dir: "video", type: FileType.Video },
  { dir: "audio", type: FileType.Audio },
  { dir: "doc", type: FileType.Document },
] as const;

const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>';

// ==========================================
// 认证中间件
// ==========================================

export const webdavAuth = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const env = c.env;

    // OPTIONS 用于能力发现（Windows/macOS 挂载前会先无凭据探测），无需认证
    if (c.req.method === "OPTIONS") {
      await next();
      return;
    }

    const authHeader = c.req.header("Authorization") ?? "";

    if (authHeader.startsWith("Basic ")) {
      const pass = extractBasicPassword(authHeader.slice(6));
      if (
        (env.PASSWORD && pass === env.PASSWORD) ||
        (env.API_TOKEN && pass === env.API_TOKEN)
      ) {
        await next();
        return;
      }
    } else if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      if (env.API_TOKEN && token === env.API_TOKEN) {
        await next();
        return;
      }
    } else {
      // 兼容浏览器已登录场景：Cookie 中的 JWT
      const authCookie = c.req
        .header("Cookie")
        ?.match(/(?:^|;\s*)auth=([^;]+)/)?.[1];
      if (authCookie) {
        try {
          await verifyJWT(
            authCookie,
            env.JWT_SECRET || env.PASSWORD || "secret"
          );
          await next();
          return;
        } catch {
          // fallthrough 到 401
        }
      }
    }

    if (!env.PASSWORD && !env.API_TOKEN) {
      return textResponse(
        503,
        "WebDAV disabled: neither PASSWORD nor API_TOKEN is configured"
      );
    }

    return new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }
);

function extractBasicPassword(encoded: string): string {
  try {
    const bytes = Uint8Array.from(atob(encoded.trim()), (ch) =>
      ch.charCodeAt(0)
    );
    const decoded = new TextDecoder().decode(bytes);
    const idx = decoded.indexOf(":");
    return idx >= 0 ? decoded.slice(idx + 1) : decoded;
  } catch {
    return "";
  }
}

// ==========================================
// 路径解析
// ==========================================

type DavPath =
  | { kind: "root" }
  | { kind: "collection"; type: FileType; dir: string }
  // 类型目录下的子目录（dirPath 为相对路径，无尾斜杠，如 "a/b"；type 根用 ""）
  | { kind: "subdir"; type: FileType; dir: string; dirPath: string }
  // 类型目录（或其子目录）下的文件（fileName 为相对路径，如 "a/b/c.txt"）
  | { kind: "file"; type: FileType; dir: string; fileName: string };

/** 从任意 URL / 路径解析出 WebDAV 资源，非法路径返回 null
 *  嵌套目录：/dav/{type}/{sub...}/{name}，末段无尾斜杠视为文件，
 *  有尾斜杠视为目录（与标准 WebDAV 客户端行为一致）
 */
function parseDavTarget(target: string): DavPath | null {
  let pathname: string;
  try {
    pathname = target.startsWith("/") ? target : new URL(target).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(DAV_BASE)) return null;

  const trailingSlash = pathname.endsWith("/");
  let segments: string[];
  try {
    segments = pathname
      .slice(DAV_BASE.length)
      .split("/")
      .filter((s) => s.length > 0)
      .map(decodeURIComponent);
  } catch {
    return null;
  }

  // 安全校验：拒绝路径穿越与控制字符（解码后段内不得再含斜杠，防 %2F 穿越编码）
  for (const seg of segments) {
    if (
      seg === "." ||
      seg === ".." ||
      seg.includes("/") ||
      seg.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(seg)
    ) {
      return null;
    }
  }

  if (segments.length === 0) return { kind: "root" };

  const entry = TYPE_DIRS.find((d) => d.dir === segments[0]);
  if (!entry) return null;

  const rest = segments.slice(1);
  if (rest.length === 0) {
    return { kind: "collection", type: entry.type, dir: entry.dir };
  }

  // 末段带尾斜杠 → 目录；不带 → 文件（无尾斜杠的目录由处理器动态兜底）
  if (trailingSlash) {
    return {
      kind: "subdir",
      type: entry.type,
      dir: entry.dir,
      dirPath: rest.join("/"),
    };
  }
  const fileName = rest.join("/");
  return {
    kind: "file",
    type: entry.type,
    dir: entry.dir,
    fileName,
  };
}

// ==========================================
// KV 查询辅助
// ==========================================

/** 分片是否已上传完整（未完成的上传不在 WebDAV 中可见） */
export function isCompleteFile(md: FileMetadata | null | undefined): boolean {
  if (!md) return false;
  if (md.chunkInfo) {
    return (md.chunkInfo.uploadedIndices?.length ?? 0) >= md.chunkInfo.total;
  }
  return true;
}

// ---- 目录模型 ----
// MKCOL 创建的目录以 KV 标记记录：key = {type}:dir:{dirPath}，
// metadata.fileName = dirPath（相对类型目录的路径），isDir = true。
// 文件的 metadata.fileName 同样存相对路径（如 "photos/2024/a.jpg"），
// 目录列表 = 目录标记 ∪ 文件路径前缀推导出的隐式子目录。

export function dirMarkerKey(type: FileType, dirPath: string): string {
  return `${type}:dir:${dirPath}`;
}

/** 类型下全部条目（文件 + 目录标记），自动翻页 */
export async function listAllOfType(
  kv: any,
  type: FileType
): Promise<FileItem[]> {
  const out: FileItem[] = [];
  let cursor: string | undefined;
  let guard = 0;
  do {
    const res = await kv.list({ prefix: `${type}:`, limit: 1000, cursor });
    for (const k of res.keys ?? []) {
      out.push({ name: k.name, metadata: k.metadata });
    }
    cursor = res.list_complete ? undefined : res.cursor;
    guard += 1;
  } while (cursor && guard < 100);
  return out;
}

export type DirEntry =
  | { kind: "file"; item: FileItem }
  | { kind: "dir"; name: string; uploadedAt: number };

/** 列出某目录下的直接子项（文件 + 子目录），dirPath 为 "" 表示类型根 */
export async function listDirEntries(
  kv: any,
  type: FileType,
  dirPath: string
): Promise<DirEntry[]> {
  const prefix = dirPath ? `${dirPath}/` : "";
  const files: DirEntry[] = [];
  const dirs = new Map<string, number>();

  for (const item of await listAllOfType(kv, type)) {
    const md = item.metadata;
    if (!md) continue;
    const name = md.fileName ?? "";
    if (md.isDir) {
      // 目录标记：仅统计直接子目录（下钻一层）
      if (name === dirPath) continue;
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      const seg = rest.split("/")[0];
      if (!seg || rest.includes("/")) continue; // 更深层的目录标记由其父目录展示
      dirs.set(seg, Math.max(dirs.get(seg) ?? 0, md.uploadedAt ?? 0));
      continue;
    }
    if (!isCompleteFile(md)) continue;
    if (dirPath === "") {
      if (name.includes("/")) {
        // 隐式子目录：取路径第一段
        const seg = name.split("/")[0];
        dirs.set(seg, Math.max(dirs.get(seg) ?? 0, md.uploadedAt ?? 0));
      } else {
        files.push({ kind: "file", item });
      }
    } else {
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      if (rest.includes("/")) {
        const seg = rest.split("/")[0];
        dirs.set(seg, Math.max(dirs.get(seg) ?? 0, md.uploadedAt ?? 0));
      } else {
        files.push({ kind: "file", item });
      }
    }
  }

  const dirEntries: DirEntry[] = [...dirs.entries()].map(
    ([name, uploadedAt]) => ({
      kind: "dir",
      name,
      uploadedAt,
    })
  );
  return [...dirEntries, ...files];
}

/** 目录是否存在：显式标记存在（fileName 与路径一致），或该前缀下有任意条目（隐式目录） */
export async function dirExists(
  kv: any,
  type: FileType,
  dirPath: string
): Promise<boolean> {
  // 注意不能用解构调用（远程 KV 适配器的方法依赖 this 绑定）
  // 且必须校验 fileName：改名/移动后的旧 key 可能仍存在但 fileName 已指向新路径
  const marker: { metadata?: FileMetadata } | null = await kv.getWithMetadata(
    dirMarkerKey(type, dirPath)
  );
  if (marker?.metadata?.fileName === dirPath) return true;
  const prefix = `${dirPath}/`;
  for (const item of await listAllOfType(kv, type)) {
    const md = item.metadata;
    if (!md) continue;
    if (
      md.isDir
        ? md.fileName === dirPath
        : (md.fileName ?? "").startsWith(prefix)
    ) {
      return true;
    }
  }
  return false;
}

/** 目录下（含递归）是否存在真实文件（目录标记不算） */
async function dirHasFiles(
  kv: any,
  type: FileType,
  dirPath: string
): Promise<boolean> {
  const prefix = `${dirPath}/`;
  for (const item of await listAllOfType(kv, type)) {
    const md = item.metadata;
    if (md?.isDir) continue;
    if ((md?.fileName ?? "").startsWith(prefix) && isCompleteFile(md)) {
      return true;
    }
  }
  return false;
}

/** 仅在指定类型目录内按文件名精确查找（不做跨类型兜底），用于 MOVE/COPY 目标占位检查 */
async function findFileInType(
  kv: any,
  type: FileType,
  fileName: string
): Promise<{ key: string; metadata: FileMetadata } | null> {
  for (const item of await listAllOfType(kv, type)) {
    const md = item.metadata;
    if (!md?.isDir && md?.fileName === fileName && isCompleteFile(md)) {
      return { key: item.name, metadata: md as FileMetadata };
    }
  }
  return null;
}

/** 按文件名在指定类型内查找文件（不做跨类型兜底：
 *  跨类型 MOVE/COPY 已是真实复制，文件在目标类型真实存在，
 *  全局兜底会让其他目录路径错误命中同名文件，破坏目录隔离语义） */
export async function findFileByName(
  kv: any,
  fileName: string,
  preferredType?: FileType
): Promise<{ key: string; metadata: FileMetadata } | null> {
  const type = preferredType ?? TYPE_DIRS[0].type;
  return findFileInType(kv, type, fileName);
}

// ==========================================
// XML 构建
// ==========================================

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function encodeHrefPath(path: string): string {
  return path
    .split("/")
    .map((seg) => (seg === "" ? "" : encodeURIComponent(seg)))
    .join("/");
}

const LOCK_SUPPORT =
  "<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>";

function collectionResponse(
  href: string,
  displayName: string,
  lastModified: number = 0
): string {
  return (
    `<D:response><D:href>${xmlEscape(encodeHrefPath(href))}</D:href>` +
    `<D:propstat><D:prop>` +
    `<D:displayname>${xmlEscape(displayName)}</D:displayname>` +
    `<D:resourcetype><D:collection/></D:resourcetype>` +
    `<D:getcontenttype>httpd/unix-directory</D:getcontenttype>` +
    `<D:getcontentlength>0</D:getcontentlength>` +
    `<D:getlastmodified>${new Date(lastModified).toUTCString()}</D:getlastmodified>` +
    `<D:creationdate>${new Date(lastModified).toISOString()}</D:creationdate>` +
    LOCK_SUPPORT +
    `<D:lockdiscovery/>` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  );
}

function fileResponse(href: string, item: FileItem): string {
  const md = item.metadata;
  return (
    `<D:response><D:href>${xmlEscape(encodeHrefPath(href))}</D:href>` +
    `<D:propstat><D:prop>` +
    `<D:displayname>${xmlEscape(md.fileName)}</D:displayname>` +
    `<D:resourcetype/>` +
    `<D:getcontentlength>${md.fileSize}</D:getcontentlength>` +
    `<D:getcontenttype>${xmlEscape(
      getContentTypeByExt(getFileExt(md.fileName))
    )}</D:getcontenttype>` +
    `<D:getlastmodified>${new Date(md.uploadedAt).toUTCString()}</D:getlastmodified>` +
    `<D:creationdate>${new Date(md.uploadedAt).toISOString()}</D:creationdate>` +
    `<D:getetag>"${xmlEscape(item.name)}"</D:getetag>` +
    LOCK_SUPPORT +
    `<D:lockdiscovery/>` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  );
}

function multistatusResponse(responses: string[]): Response {
  const body = `${XML_HEADER}<D:multistatus xmlns:D="DAV:">${responses.join(
    ""
  )}</D:multistatus>`;
  return new Response(body, {
    status: 207,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Allow: DAV_ALLOW,
    },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

// ==========================================
// 流式读取辅助：按需精确读取 N 字节（处理读取过量保留问题）
// ==========================================

class ChunkReader {
  private queue: Uint8Array<ArrayBufferLike>[] = [];
  private queued = 0;

  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async read(n: number): Promise<Uint8Array<ArrayBuffer>> {
    while (this.queued < n) {
      const { done, value } = await this.reader.read();
      if (done) break;
      this.queue.push(value);
      this.queued += value.byteLength;
    }
    const available = Math.min(this.queued, n);
    const out = new Uint8Array(available);
    let off = 0;
    while (off < available && this.queue.length > 0) {
      const head = this.queue[0];
      const take = Math.min(head.byteLength, available - off);
      out.set(head.subarray(0, take), off);
      off += take;
      this.queued -= take;
      if (take === head.byteLength) this.queue.shift();
      else this.queue[0] = head.subarray(take);
    }
    return out;
  }
}

// ==========================================
// 上传辅助
// ==========================================

export function buildMetadata(
  fileName: string,
  fileSize: number,
  totalChunks?: number
): FileMetadata {
  return {
    fileName,
    fileSize,
    uploadedAt: Date.now(),
    liked: false,
    ...(totalChunks
      ? { chunkInfo: { total: totalChunks, uploadedIndices: [] } }
      : {}),
  };
}

/** 初始化分片上传记录（与 /upload/chunk/init 逻辑一致） */
export async function initChunkedKey(
  kv: any,
  type: FileType,
  fileName: string,
  fileSize: number,
  totalChunks: number
): Promise<string> {
  const key = buildKeyId(
    type,
    `${chunkPrefix}${getUniqueFileId()}`,
    getFileExt(fileName)
  );
  await kv.put(key, "", {
    metadata: buildMetadata(fileName, fileSize, totalChunks),
    expirationTtl: TEMP_CHUNK_TTL,
  });
  return key;
}

interface PutResult {
  key: string;
}

/** 小文件直接上传 */
export async function putSmall(
  c: Context<{ Bindings: Env }>,
  fileName: string,
  mime: string,
  buf: ArrayBuffer
): Promise<PutResult> {
  const db = DBAdapterFactory.getAdapter(c.env);
  const file = new File([buf], fileName, { type: mime });
  const metadata = buildMetadata(fileName, file.size);
  return db.uploadFile(file, metadata, (p) => c.executionCtx.waitUntil(p));
}

/**
 * 大文件分片上传：按 MAX_CHUNK_SIZE 切片，逐片同步等待落库
 * （不传 waitUntil，uploadChunk 会 await 完成，保证返回时文件已可读）
 */
async function putChunked(
  c: Context<{ Bindings: Env }>,
  type: FileType,
  fileName: string,
  mime: string,
  reader: ChunkReader,
  size: number
): Promise<PutResult> {
  const db = DBAdapterFactory.getAdapter(c.env);
  const kv = c.env.oh_file_url;
  const totalChunks = Math.ceil(size / MAX_CHUNK_SIZE);
  if (totalChunks > MAX_CHUNK_NUM) {
    throw new Error(`Too many chunks: ${totalChunks} > ${MAX_CHUNK_NUM}`);
  }

  const key = await initChunkedKey(kv, type, fileName, size, totalChunks);
  try {
    let received = 0;
    for (let i = 0; i < totalChunks; i++) {
      const target = Math.min(MAX_CHUNK_SIZE, size - i * MAX_CHUNK_SIZE);
      const part = await reader.read(target);
      received += part.byteLength;
      if (part.byteLength === 0) {
        throw new Error(`Unexpected EOF at chunk ${i}`);
      }
      await db.uploadChunk(key, i, new Blob([part], { type: mime }));
    }
    if (received !== size) {
      throw new Error(`Size mismatch: received ${received}, expected ${size}`);
    }
    return { key };
  } catch (e) {
    await kv.delete(key).catch(() => {});
    throw e;
  }
}

// ==========================================
// 各方法处理器
// ==========================================

function handleOptions(): Response {
  return new Response(null, {
    status: 200,
    headers: {
      DAV: DAV_CLASS,
      Allow: DAV_ALLOW,
      "MS-Author-Via": "DAV",
      "Accept-Ranges": "bytes",
      "Content-Length": "0",
    },
  });
}

async function handlePropfind(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const target = parseDavTarget(c.req.url);
  if (!target) return textResponse(404, "Not Found");

  const depthHeader = (c.req.header("Depth") ?? "1").toLowerCase();
  const depth = depthHeader === "0" ? 0 : 1; // infinity 按 1 处理
  const kv = c.env.oh_file_url;
  const responses: string[] = [];

  if (target.kind === "root") {
    responses.push(collectionResponse(`${DAV_BASE}/`, "dav"));
    if (depth === 1) {
      for (const d of TYPE_DIRS) {
        responses.push(collectionResponse(`${DAV_BASE}/${d.dir}/`, d.dir));
      }
    }
  } else if (target.kind === "collection" || target.kind === "subdir") {
    const dirPath = target.kind === "subdir" ? target.dirPath : "";
    if (
      target.kind === "subdir" &&
      !(await dirExists(kv, target.type, dirPath))
    ) {
      return textResponse(404, "Not Found");
    }
    const baseHref = `${DAV_BASE}/${target.dir}${dirPath ? `/${dirPath}` : ""}/`;
    responses.push(
      collectionResponse(baseHref, dirPath.split("/").pop() || target.dir)
    );
    if (depth === 1) {
      for (const entry of await listDirEntries(kv, target.type, dirPath)) {
        if (entry.kind === "dir") {
          responses.push(
            collectionResponse(
              `${baseHref}${entry.name}/`,
              entry.name,
              entry.uploadedAt
            )
          );
        } else {
          responses.push(
            fileResponse(
              `${DAV_BASE}/${target.dir}/${entry.item.metadata.fileName}`,
              entry.item
            )
          );
        }
      }
    }
  } else {
    // file 路径：先按文件找，找不到再按目录兜底（无尾斜杠目录）
    const found = await findFileByName(kv, target.fileName, target.type);
    if (found) {
      responses.push(
        fileResponse(`${DAV_BASE}/${target.dir}/${found.metadata.fileName}`, {
          name: found.key,
          metadata: found.metadata,
        })
      );
    } else if (await dirExists(kv, target.type, target.fileName)) {
      responses.push(
        collectionResponse(
          `${DAV_BASE}/${target.dir}/${target.fileName}/`,
          target.fileName.split("/").pop() || target.fileName
        )
      );
      if (depth === 1) {
        for (const entry of await listDirEntries(
          kv,
          target.type,
          target.fileName
        )) {
          if (entry.kind === "dir") {
            responses.push(
              collectionResponse(
                `${DAV_BASE}/${target.dir}/${target.fileName}/${entry.name}/`,
                entry.name,
                entry.uploadedAt
              )
            );
          } else {
            responses.push(
              fileResponse(
                `${DAV_BASE}/${target.dir}/${entry.item.metadata.fileName}`,
                entry.item
              )
            );
          }
        }
      }
    } else {
      return textResponse(404, "Not Found");
    }
  }

  return multistatusResponse(responses);
}

async function handleGetHead(c: Context<{ Bindings: Env }>): Promise<Response> {
  const target = parseDavTarget(c.req.url);
  if (!target) return textResponse(404, "Not Found");

  const kv = c.env.oh_file_url;
  const db = DBAdapterFactory.getAdapter(c.env);

  let filePath: string | null = null;
  let preferredType: FileType | undefined;
  if (target.kind === "file") {
    filePath = target.fileName;
    preferredType = target.type;
  }

  if (filePath !== null) {
    const found = await findFileByName(kv, filePath, preferredType);
    if (found) {
      // 空文件（0 字节）：直接返回空内容，保证 Content-Length: 0（TG 物理存储为 1 字节占位）
      if (found.metadata.fileSize === 0 || found.metadata.emptyFile) {
        const range = c.req.header("Range");
        const ext = getFileExt(found.metadata.fileName);
        const headers = new Headers({
          "Content-Type": getContentTypeByExt(ext),
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(found.metadata.fileName)}`,
          ETag: `"${found.key}"`,
          "Last-Modified": new Date(found.metadata.uploadedAt).toUTCString(),
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-store",
          "Content-Length": "0",
        });
        if (range) {
          headers.set("Content-Range", "bytes */0");
          return new Response(null, { status: 416, headers });
        }
        return new Response(c.req.method === "HEAD" ? null : null, {
          status: 200,
          headers,
        });
      }
      const resp = await db.get(found.key, c.req.raw);
      const headers = new Headers(resp.headers);
      headers.set("ETag", `"${found.key}"`);
      headers.set(
        "Last-Modified",
        new Date(found.metadata.uploadedAt).toUTCString()
      );
      headers.set("Accept-Ranges", "bytes");
      headers.set("Cache-Control", "private, no-store");
      return new Response(c.req.method === "HEAD" ? null : resp.body, {
        status: resp.status,
        headers,
      });
    }
    // 无尾斜杠目录兜底：交给下方目录索引逻辑
  }

  // 目录：返回简单 HTML 索引（便于浏览器快速验证）
  let listType: FileType | null = null;
  let dirPath = "";
  if (target.kind === "root") {
    const parts = TYPE_DIRS.map(
      (d) => `<li><a href="${d.dir}/">${d.dir}/</a></li>`
    );
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>OtterHub WebDAV</title></head><body><h1>OtterHub WebDAV</h1><ul>${parts.join(
      ""
    )}</ul></body></html>`;
    return c.html(html);
  } else if (target.kind === "collection") {
    listType = target.type;
  } else if (target.kind === "subdir") {
    listType = target.type;
    dirPath = target.dirPath;
  } else if (target.kind === "file") {
    // 无尾斜杠的目录：存在则列目录，否则 404
    listType = target.type;
    dirPath = target.fileName;
    if (!(await dirExists(kv, listType, dirPath))) {
      return textResponse(404, "Not Found");
    }
  }

  const parts: string[] = [];
  for (const entry of await listDirEntries(kv, listType!, dirPath)) {
    if (entry.kind === "dir") {
      const href = encodeHrefPath(`${entry.name}/`);
      parts.push(`<li><a href="${href}">${xmlEscape(entry.name)}/</a></li>`);
    } else {
      const href = encodeHrefPath(entry.item.metadata.fileName);
      parts.push(
        `<li><a href="${xmlEscape(href)}">${xmlEscape(
          entry.item.metadata.fileName.split("/").pop() ||
            entry.item.metadata.fileName
        )}</a> (${entry.item.metadata.fileSize} bytes)</li>`
      );
    }
  }
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>OtterHub WebDAV</title></head><body><h1>OtterHub WebDAV</h1><ul>${parts.join(
    ""
  )}</ul></body></html>`;
  return c.html(html);
}

async function handlePut(c: Context<{ Bindings: Env }>): Promise<Response> {
  const target = parseDavTarget(c.req.url);
  if (!target || target.kind !== "file") {
    return textResponse(405, "PUT only supported on file paths");
  }
  const fileName = target.fileName;
  // 嵌套路径校验：每段非空且 ≤ MAX_FILENAME_LENGTH，总长 ≤ MAX_PATH_LENGTH
  const segs = fileName.split("/");
  if (
    !fileName.trim() ||
    fileName.length > MAX_PATH_LENGTH ||
    segs.some((s) => !s.trim() || s.length > MAX_FILENAME_LENGTH)
  ) {
    return textResponse(400, "Invalid file name");
  }

  const kv = c.env.oh_file_url;
  const db = DBAdapterFactory.getAdapter(c.env);

  // 覆盖语义：旧文件移入回收站
  const existing = await findFileByName(kv, fileName, target.type);
  if (existing) {
    await db.moveToTrash(existing.key);
    const origin = new URL(c.req.url).origin;
    c.executionCtx.waitUntil(
      deleteFileCache(origin, existing.key).catch(() => {})
    );
  }

  const mime = getContentTypeByExt(getFileExt(fileName));
  const clHeader = c.req.header("Content-Length");
  const contentLength = clHeader ? parseInt(clHeader, 10) : NaN;

  try {
    if (!c.req.raw.body) {
      // 空body（无流）：按0字节处理
      await putSmall(c, fileName, mime, new ArrayBuffer(0));
    } else if (!isNaN(contentLength)) {
      if (contentLength > MAX_FILE_SIZE) {
        return textResponse(507, "Insufficient Storage");
      }
      if (contentLength <= MAX_CHUNK_SIZE) {
        const buf = await c.req.raw.arrayBuffer();
        await putSmall(c, fileName, mime, buf);
      } else {
        const reader = new ChunkReader(c.req.raw.body.getReader());
        await putChunked(c, target.type, fileName, mime, reader, contentLength);
      }
    } else {
      // 未知长度：全部缓冲后再决定（WebDAV 客户端几乎都会带 Content-Length）
      const buf = await c.req.raw.arrayBuffer();
      if (buf.byteLength > MAX_FILE_SIZE) {
        return textResponse(507, "Insufficient Storage");
      }
      if (buf.byteLength <= MAX_CHUNK_SIZE) {
        await putSmall(c, fileName, mime, buf);
      } else {
        // 用内存块构造流式分片
        const parts: Uint8Array[] = [];
        let off = 0;
        while (off < buf.byteLength) {
          parts.push(
            new Uint8Array(
              buf,
              off,
              Math.min(MAX_CHUNK_SIZE, buf.byteLength - off)
            )
          );
          off += MAX_CHUNK_SIZE;
        }
        const stream = new ReadableStream({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        });
        const reader = new ChunkReader(stream.getReader());
        await putChunked(
          c,
          target.type,
          fileName,
          mime,
          reader,
          buf.byteLength
        );
      }
    }
    return emptyResponse(existing ? 204 : 201);
  } catch (e: any) {
    console.error("[WebDAV] PUT error:", e);
    return textResponse(500, `PUT failed: ${e?.message ?? e}`);
  }
}

async function handleDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const target = parseDavTarget(c.req.url);
  if (!target) return textResponse(404, "Not Found");
  if (target.kind === "root") {
    return textResponse(405, "Root cannot be deleted");
  }

  const kv = c.env.oh_file_url;
  const db = DBAdapterFactory.getAdapter(c.env);
  const origin = new URL(c.req.url).origin;

  // 目录删除：仅允许删除空目录（标准 WebDAV 409 语义；alist 删目录会先递归删内容）
  if (target.kind === "subdir" || target.kind === "collection") {
    if (target.kind === "collection") {
      return textResponse(405, "Root collections cannot be deleted");
    }
    if (!(await dirExists(kv, target.type, target.dirPath))) {
      return textResponse(404, "Not Found");
    }
    if (await dirHasFiles(kv, target.type, target.dirPath)) {
      return textResponse(409, "Directory not empty");
    }
    // 删除该目录及所有子孙目录标记（此时只剩空目录标记）
    const prefix = `${target.dirPath}/`;
    for (const item of await listAllOfType(kv, target.type)) {
      const md = item.metadata;
      if (
        md?.isDir &&
        (md.fileName === target.dirPath || md.fileName.startsWith(prefix))
      ) {
        await kv.delete(item.name).catch(() => {});
      }
    }
    return emptyResponse(204);
  }

  // 文件删除；无尾斜杠的目录路径也走此兜底
  const found = await findFileByName(kv, target.fileName, target.type);
  if (!found) {
    // 可能是无尾斜杠目录
    if (await dirExists(kv, target.type, target.fileName)) {
      if (await dirHasFiles(kv, target.type, target.fileName)) {
        return textResponse(409, "Directory not empty");
      }
      const prefix = `${target.fileName}/`;
      for (const item of await listAllOfType(kv, target.type)) {
        const md = item.metadata;
        if (
          md?.isDir &&
          (md.fileName === target.fileName || md.fileName.startsWith(prefix))
        ) {
          await kv.delete(item.name).catch(() => {});
        }
      }
      return emptyResponse(204);
    }
    return textResponse(404, "Not Found");
  }

  await db.moveToTrash(found.key);
  c.executionCtx.waitUntil(deleteFileCache(origin, found.key).catch(() => {}));
  return emptyResponse(204);
}

// ==========================================
// MKCOL：在类型目录下创建真实子目录
// ==========================================

async function handleMkcol(c: Context<{ Bindings: Env }>): Promise<Response> {
  const target = parseDavTarget(c.req.url);

  if (!target || target.kind === "root" || target.kind === "collection") {
    return textResponse(
      405,
      "Root collections are fixed (img, video, audio, doc); create subdirectories inside them"
    );
  }

  // MKCOL 不接受请求体（扩展 MKCOL 返回 415）
  const body = await c.req.text().catch(() => "");
  if (body.trim()) {
    return textResponse(415, "Unsupported Media Type");
  }

  const kv = c.env.oh_file_url;

  let dirPath: string;
  if (target.kind === "subdir") {
    dirPath = target.dirPath;
  } else {
    // 无尾斜杠的 MKCOL（部分客户端）：按目录处理
    dirPath = target.fileName;
  }

  if (dirPath.length > MAX_PATH_LENGTH) {
    return textResponse(400, "Path too long");
  }

  // 已存在（标记或隐式有内容）→ 405
  if (await dirExists(kv, target.type, dirPath)) {
    return textResponse(405, "Collection already exists");
  }

  // 父目录必须存在（标准 409）；类型根目录视为存在
  const parent = dirPath.includes("/")
    ? dirPath.slice(0, dirPath.lastIndexOf("/"))
    : "";
  if (parent && !(await dirExists(kv, target.type, parent))) {
    return textResponse(409, "Parent collection does not exist");
  }

  const now = Date.now();
  await kv.put(dirMarkerKey(target.type, dirPath), "", {
    metadata: {
      fileName: dirPath,
      fileSize: 0,
      uploadedAt: now,
      liked: false,
      isDir: true,
    } satisfies FileMetadata,
  });
  return emptyResponse(201);
}

function parseDestination(
  c: Context<{ Bindings: Env }>
): DavPath | null | "missing" {
  const dest = c.req.header("Destination");
  if (!dest) return "missing";
  return parseDavTarget(dest);
}

/** 从 Destination 头解析目标路径（文件名或目录路径），统一返回字符串路径 */
function destPathOf(dest: DavPath): string | null {
  if (dest.kind === "file") return dest.fileName;
  if (dest.kind === "subdir") return dest.dirPath;
  return null; // root / collection 不是合法目标
}

async function resolveMoveCopyContext(
  c: Context<{ Bindings: Env }>,
  target: DavPath & { kind: "file" }
): Promise<
  | { error: Response }
  | {
      src: { key: string; metadata: FileMetadata };
      dest: { type: FileType; dir: string; fileName: string };
      replacedExisting: boolean;
    }
> {
  const kv = c.env.oh_file_url;
  const db = DBAdapterFactory.getAdapter(c.env);

  const src = await findFileByName(kv, target.fileName, target.type);
  if (!src) return { error: textResponse(404, "Source Not Found") };

  const destParsed = parseDestination(c);
  if (destParsed === "missing") {
    return { error: textResponse(400, "Missing Destination header") };
  }
  if (
    !destParsed ||
    (destParsed.kind !== "file" && destParsed.kind !== "subdir")
  ) {
    return { error: textResponse(400, "Invalid Destination") };
  }
  const destFileName =
    destParsed.kind === "file" ? destParsed.fileName : destParsed.dirPath;
  if (destFileName === target.fileName && destParsed.type === target.type) {
    return {
      error: textResponse(403, "Source and destination are the same resource"),
    };
  }

  const overwrite = (c.req.header("Overwrite") ?? "F").toUpperCase() === "T";
  // 目标占位检查必须精确限定在目标类型目录内：
  // 全局兜底解析会把“仍留在原类型目录下的源文件自身”误判为目标已存在，导致源文件被误删
  const destExisting = await findFileInType(kv, destParsed.type, destFileName);
  let replacedExisting = false;
  if (destExisting) {
    if (destExisting.key === src.key) {
      // 目标位置解析到的正是源文件自身（跨目录移动），直接重命名即可
      return {
        src,
        dest: {
          type: destParsed.type,
          dir: destParsed.dir,
          fileName: destFileName,
        },
        replacedExisting: false,
      };
    }
    if (!overwrite) {
      return {
        error: textResponse(412, "Destination exists and Overwrite is not T"),
      };
    }
    await db.moveToTrash(destExisting.key);
    const origin = new URL(c.req.url).origin;
    c.executionCtx.waitUntil(
      deleteFileCache(origin, destExisting.key).catch(() => {})
    );
    replacedExisting = true;
  }

  return {
    src,
    dest: {
      type: destParsed.type,
      dir: destParsed.dir,
      fileName: destFileName,
    },
    replacedExisting,
  };
}

/** 读取源文件并作为新文件写入（跨类型 MOVE/COPY 共用）
 *  统一走 putChunked（显式指定目标类型）：db.uploadFile 会按 MIME/扩展名
 *  推断类型，嵌套路径（如 img/xx/readme.txt）会被误判回原类型，导致目标目录列表不可见
 */
async function copyFileContent(
  c: Context<{ Bindings: Env }>,
  srcKey: string,
  srcSize: number,
  destType: FileType,
  destFileName: string,
  fallbackMime?: string
): Promise<void> {
  const db = DBAdapterFactory.getAdapter(c.env);
  const srcResp = await db.get(srcKey);
  if (!srcResp.body || srcResp.status !== 200) {
    throw new Error("Failed to read source file");
  }
  const mime =
    srcResp.headers.get("Content-Type") ??
    fallbackMime ??
    getContentTypeByExt(getFileExt(destFileName));
  const reader = new ChunkReader(srcResp.body.getReader());
  await putChunked(c, destType, destFileName, mime, reader, srcSize);
}

/**
 * MOVE 文件 = 重命名（仅更新 metadata.fileName，KV key 与物理存储不变）
 * 跨类型目录移动时改用“复制 + 删除”，保证文件在新类型的目录列表中可见
 */
async function handleMove(c: Context<{ Bindings: Env }>): Promise<Response> {
  const target = parseDavTarget(c.req.url);
  if (!target) return textResponse(400, "Invalid path");
  if (target.kind === "root" || target.kind === "collection") {
    return textResponse(400, "MOVE only supported on files/directories");
  }

  // ---- 目录 MOVE ----
  let srcDirPath: string | null = null;
  if (target.kind === "subdir") {
    srcDirPath = target.dirPath;
  } else {
    // 无尾斜杠：文件不存在但目录存在 → 目录 MOVE
    const kv0 = c.env.oh_file_url;
    if (
      !(await findFileByName(kv0, target.fileName, target.type)) &&
      (await dirExists(kv0, target.type, target.fileName))
    ) {
      srcDirPath = target.fileName;
    }
  }
  if (srcDirPath !== null) {
    return await handleMoveDir(c, target.type, target.dir, srcDirPath);
  }

  if (target.kind !== "file") {
    return textResponse(400, "MOVE only supported on file paths");
  }

  // ---- 文件 MOVE ----
  const ctx = await resolveMoveCopyContext(c, target);
  if ("error" in ctx) return ctx.error;

  const kv = c.env.oh_file_url;

  if (
    ctx.src.key.startsWith(`${target.type}:`) &&
    ctx.dest.type === target.type
  ) {
    // 同类型：轻量重命名
    const { value, metadata } = await kv.getWithMetadata<FileMetadata>(
      ctx.src.key
    );
    metadata.fileName = ctx.dest.fileName;
    await kv.put(ctx.src.key, value, { metadata });
    return emptyResponse(ctx.replacedExisting ? 204 : 201);
  }

  // 跨类型：复制内容到新类型再删除旧文件（保证目标目录列表可见）
  try {
    await copyFileContent(
      c,
      ctx.src.key,
      ctx.src.metadata.fileSize,
      ctx.dest.type,
      ctx.dest.fileName,
      getContentTypeByExt(getFileExt(ctx.dest.fileName))
    );
    const db = DBAdapterFactory.getAdapter(c.env);
    await db.moveToTrash(ctx.src.key);
    const origin = new URL(c.req.url).origin;
    c.executionCtx.waitUntil(
      deleteFileCache(origin, ctx.src.key).catch(() => {})
    );
    return emptyResponse(ctx.replacedExisting ? 204 : 201);
  } catch (e: any) {
    console.error("[WebDAV] cross-type MOVE error:", e);
    return textResponse(500, `MOVE failed: ${e?.message ?? e}`);
  }
}

/**
 * MOVE 目录：重命名目录前缀（同类型批量改 metadata.fileName）
 * 跨类型目录移动：逐文件复制 + 删除旧文件 + 重建目录标记
 */
async function handleMoveDir(
  c: Context<{ Bindings: Env }>,
  srcType: FileType,
  srcDir: string,
  srcDirPath: string
): Promise<Response> {
  const kv = c.env.oh_file_url;

  const destParsed = parseDestination(c);
  if (destParsed === "missing") {
    return textResponse(400, "Missing Destination header");
  }
  if (
    !destParsed ||
    (destParsed.kind !== "file" && destParsed.kind !== "subdir")
  ) {
    return textResponse(400, "Invalid Destination");
  }
  const destDirPath = destPathOf(destParsed);
  if (destDirPath === null) {
    return textResponse(400, "Invalid Destination");
  }
  if (destParsed.type === srcType && destDirPath === srcDirPath) {
    return textResponse(403, "Source and destination are the same resource");
  }
  if (destDirPath.startsWith(`${srcDirPath}/`)) {
    return textResponse(409, "Cannot move a directory into itself");
  }

  // 目标已存在（目录或同名文件）→ 412
  if (
    (await dirExists(kv, destParsed.type, destDirPath)) ||
    (await findFileInType(kv, destParsed.type, destDirPath))
  ) {
    return textResponse(412, "Destination exists");
  }

  // 收集源目录内容
  const srcEntries = await listAllOfType(kv, srcType);
  const srcPrefix = `${srcDirPath}/`;
  const dirMarkers = srcEntries.filter(
    (it) =>
      it.metadata?.isDir &&
      (it.metadata.fileName === srcDirPath ||
        it.metadata.fileName.startsWith(srcPrefix))
  );
  const files = srcEntries.filter(
    (it) =>
      !it.metadata?.isDir &&
      (it.metadata?.fileName ?? "").startsWith(srcPrefix) &&
      isCompleteFile(it.metadata)
  );
  // 目录不存在（无标记且无内容）
  if (dirMarkers.length === 0 && files.length === 0) {
    return textResponse(404, "Source Not Found");
  }

  try {
    if (destParsed.type === srcType) {
      // 同类型：目录标记删除旧 key 写新 key（保持 key 与路径一致），文件批量改 fileName 前缀
      for (const marker of dirMarkers) {
        const md = marker.metadata as FileMetadata;
        const newName =
          md.fileName === srcDirPath
            ? destDirPath
            : `${destDirPath}${md.fileName.slice(srcDirPath.length)}`;
        await kv.put(dirMarkerKey(srcType, newName), "", {
          metadata: { ...md, fileName: newName },
        });
        await kv.delete(marker.name).catch(() => {});
      }
      for (const f of files) {
        const md = f.metadata as FileMetadata;
        const newName = `${destDirPath}${md.fileName.slice(srcDirPath.length)}`;
        const { value, metadata } = await kv.getWithMetadata<FileMetadata>(
          f.name
        );
        metadata.fileName = newName;
        await kv.put(f.name, value, { metadata });
      }
    } else {
      // 跨类型：逐文件复制 + 删除旧文件 + 重建目录标记
      const db = DBAdapterFactory.getAdapter(c.env);
      const origin = new URL(c.req.url).origin;
      for (const marker of dirMarkers) {
        const md = marker.metadata as FileMetadata;
        const newName =
          md.fileName === srcDirPath
            ? destDirPath
            : `${destDirPath}${md.fileName.slice(srcDirPath.length)}`;
        await kv.put(dirMarkerKey(destParsed.type, newName), "", {
          metadata: { ...md, fileName: newName },
        });
        await kv.delete(marker.name).catch(() => {});
      }
      // 目标目录标记（源无标记但含文件的隐式目录）
      if (
        !dirMarkers.some(
          (m) => (m.metadata as FileMetadata).fileName === srcDirPath
        )
      ) {
        await kv.put(dirMarkerKey(destParsed.type, destDirPath), "", {
          metadata: {
            fileName: destDirPath,
            fileSize: 0,
            uploadedAt: Date.now(),
            liked: false,
            isDir: true,
          } satisfies FileMetadata,
        });
      }
      for (const f of files) {
        const md = f.metadata as FileMetadata;
        const newName = `${destDirPath}${md.fileName.slice(srcDirPath.length)}`;
        await copyFileContent(
          c,
          f.name,
          md.fileSize,
          destParsed.type,
          newName,
          getContentTypeByExt(getFileExt(newName))
        );
        await db.moveToTrash(f.name);
        c.executionCtx.waitUntil(
          deleteFileCache(origin, f.name).catch(() => {})
        );
      }
    }
    return emptyResponse(201);
  } catch (e: any) {
    console.error("[WebDAV] directory MOVE error:", e);
    return textResponse(500, `MOVE failed: ${e?.message ?? e}`);
  }
}

/** COPY = 读取源文件内容后作为新文件上传；目录 COPY 不支持（客户端应递归） */
async function handleCopy(c: Context<{ Bindings: Env }>): Promise<Response> {
  const target = parseDavTarget(c.req.url);
  if (!target || target.kind !== "file") {
    return textResponse(400, "COPY only supported on file paths");
  }

  const ctx = await resolveMoveCopyContext(c, target);
  if ("error" in ctx) return ctx.error;

  try {
    await copyFileContent(
      c,
      ctx.src.key,
      ctx.src.metadata.fileSize,
      ctx.dest.type,
      ctx.dest.fileName,
      getContentTypeByExt(getFileExt(ctx.dest.fileName))
    );
    return emptyResponse(ctx.replacedExisting ? 204 : 201);
  } catch (e: any) {
    console.error("[WebDAV] COPY error:", e);
    return textResponse(500, `COPY failed: ${e?.message ?? e}`);
  }
}

async function handleProppatch(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const target = parseDavTarget(c.req.url);
  if (!target) return textResponse(404, "Not Found");

  // 回显请求中的属性并全部标记为成功（属性不持久化）
  const body = await c.req.text().catch(() => "");
  const propMatch = body.match(
    /<(?:[A-Za-z0-9_.-]+:)?prop[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?prop>/
  );
  const propsXml = propMatch?.[1] ?? "";

  const href =
    target.kind === "root"
      ? `${DAV_BASE}/`
      : target.kind === "collection"
        ? `${DAV_BASE}/${target.dir}/`
        : target.kind === "subdir"
          ? `${DAV_BASE}/${target.dir}/${encodeHrefPath(target.dirPath)}/`
          : `${DAV_BASE}/${target.dir}/${encodeHrefPath(target.fileName)}`;

  const xml =
    `${XML_HEADER}<D:multistatus xmlns:D="DAV:">` +
    `<D:response><D:href>${xmlEscape(href)}</D:href>` +
    `<D:propstat><D:prop>${propsXml}</D:prop>` +
    `<D:status>HTTP/1.1 200 OK</D:status></D:propstat>` +
    `</D:response></D:multistatus>`;
  return new Response(xml, {
    status: 207,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}

function handleLock(c: Context<{ Bindings: Env }>): Response {
  const target = parseDavTarget(c.req.url);
  if (!target) return textResponse(404, "Not Found");

  const token = `opaquelocktoken:${crypto.randomUUID()}`;
  const timeout = c.req.header("Timeout") ?? "Second-3600";

  const xml =
    `${XML_HEADER}<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
    `<D:locktype><D:write/></D:locktype>` +
    `<D:lockscope><D:exclusive/></D:lockscope>` +
    `<D:depth>infinity</D:depth>` +
    `<D:timeout>${xmlEscape(timeout)}</D:timeout>` +
    `<D:locktoken><D:href>${token}</D:href></D:locktoken>` +
    `</D:activelock></D:lockdiscovery></D:prop>`;

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Lock-Token": `<${token}>`,
    },
  });
}

function handleUnlock(): Response {
  return emptyResponse(204);
}

function methodNotAllowed(): Response {
  return textResponse(405, "Method Not Allowed");
}

// ==========================================
// 分发与路由注册
// ==========================================

async function davHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    switch (c.req.method) {
      case "OPTIONS":
        return handleOptions();
      case "PROPFIND":
        return await handlePropfind(c);
      case "PROPPATCH":
        return await handleProppatch(c);
      case "MKCOL":
        return await handleMkcol(c);
      case "GET":
      case "HEAD":
        return await handleGetHead(c);
      case "PUT":
        return await handlePut(c);
      case "DELETE":
        return await handleDelete(c);
      case "MOVE":
        return await handleMove(c);
      case "COPY":
        return await handleCopy(c);
      case "LOCK":
        return handleLock(c);
      case "UNLOCK":
        return handleUnlock();
      default:
        return methodNotAllowed();
    }
  } catch (e: any) {
    console.error("[WebDAV] Unhandled error:", e);
    return textResponse(500, `WebDAV error: ${e?.message ?? e}`);
  }
}

const DAV_METHODS = [
  "OPTIONS",
  "PROPFIND",
  "PROPPATCH",
  "MKCOL",
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "MOVE",
  "COPY",
  "LOCK",
  "UNLOCK",
] as const;

export const webdavRoutes = new Hono<{ Bindings: Env }>();

webdavRoutes.use("*", webdavAuth);

for (const method of DAV_METHODS) {
  webdavRoutes.on(method, "/", davHandler);
  webdavRoutes.on(method, "/*", davHandler);
}
