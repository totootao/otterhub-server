import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import {
  FileType,
  FileItem,
  MAX_CHUNK_SIZE,
  MAX_FILE_SIZE,
  MAX_FILENAME_LENGTH,
  MAX_PATH_LENGTH,
} from "@shared/types";
import { DBAdapterFactory } from "@utils/db-adapter";
import { deleteFileCache } from "@utils/cache";
import { getFileExt, getContentTypeByExt } from "@utils/file";
import { fail, ok } from "@utils/response";
import { authMiddleware } from "middleware/auth";
import type { Env } from "../../types/hono";
import {
  TYPE_DIRS,
  dirExists,
  dirMarkerKey,
  findFileByName,
  initChunkedKey,
  isCompleteFile,
  listAllOfType,
  listDirEntries,
  putSmall,
} from "../webdav";

// ==========================================
// 文件浏览器 API（网页端文件夹视图 + 全局搜索）
// 目录模型与 WebDAV 完全一致（复用其函数）：
//   文件路径存于 metadata.fileName（相对类型目录），key 与路径无关
//   显式目录以 {type}:dir:{path} 标记 + isDir 元数据
// 挂载于 /api/file/browser，Cookie JWT 鉴权（authMiddleware）
// ==========================================

export const browserRoutes = new Hono<{ Bindings: Env }>();

/** 相对路径校验：非空、每段合法、无路径穿越，返回规范化后的段数组；非法返回 null */
function validateRelPath(path: string): string[] | null {
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  if (!trimmed) return [];
  if (trimmed.length > MAX_PATH_LENGTH) return null;
  const segs = trimmed.split("/").map((s) => s.trim());
  if (segs.some((s) => !s || s.length > MAX_FILENAME_LENGTH)) return null;
  if (segs.some((s) => s === "." || s === ".." || s.includes("\\")))
    return null;
  return segs;
}

// ---------- 1. 目录列表 ----------

browserRoutes.get(
  "/list",
  authMiddleware,
  zValidator(
    "query",
    z.object({
      fileType: z.enum(FileType),
      path: z.string().optional().default(""),
    })
  ),
  async (c) => {
    const { fileType, path } = c.req.valid("query");
    const segs = validateRelPath(path);
    if (segs === null) return fail(c, "Invalid path", 400);

    const kv = c.env.oh_file_url;
    try {
      const entries = await listDirEntries(kv, fileType, segs.join("/"));
      return ok(c, { entries });
    } catch (err) {
      console.error("[browser:list] error:", err);
      return fail(c, "Failed to list directory");
    }
  }
);

// ---------- 2. 新建文件夹 ----------

const mkdirSchema = z.object({
  fileType: z.enum(FileType),
  path: z.string().min(1).max(MAX_PATH_LENGTH),
});

browserRoutes.post(
  "/mkdir",
  authMiddleware,
  zValidator("json", mkdirSchema),
  async (c) => {
    const { fileType, path } = c.req.valid("json");
    const segs = validateRelPath(path);
    if (segs === null || segs.length === 0) {
      return fail(c, "Invalid folder name", 400);
    }
    const dirPath = segs.join("/");
    const kv = c.env.oh_file_url;

    try {
      // 父目录必须存在（根目录恒存在）
      const parent = segs.slice(0, -1).join("/");
      if (parent && !(await dirExists(kv, fileType, parent))) {
        return fail(c, "Parent folder not found", 404);
      }
      // 目标不能与已有文件/目录冲突
      if (await dirExists(kv, fileType, dirPath)) {
        return fail(c, "Folder already exists", 409);
      }
      if (await findFileByName(kv, dirPath, fileType)) {
        return fail(c, "A file with the same name exists", 409);
      }

      await kv.put(dirMarkerKey(fileType, dirPath), "", {
        metadata: {
          fileName: dirPath,
          fileSize: 0,
          uploadedAt: Date.now(),
          liked: false,
          isDir: true,
        },
      });
      return ok(c, { path: dirPath });
    } catch (err) {
      console.error("[browser:mkdir] error:", err);
      return fail(c, "Failed to create folder");
    }
  }
);

// ---------- 3. 重命名 / 移动（同类型内，O(1) 改 metadata） ----------

const renameSchema = z.object({
  fileType: z.enum(FileType),
  from: z.string().min(1).max(MAX_PATH_LENGTH),
  to: z.string().min(1).max(MAX_PATH_LENGTH),
  isDir: z.boolean().optional().default(false),
});

browserRoutes.post(
  "/rename",
  authMiddleware,
  zValidator("json", renameSchema),
  async (c) => {
    const { fileType, from, to, isDir } = c.req.valid("json");
    const fromSegs = validateRelPath(from);
    const toSegs = validateRelPath(to);
    if (!fromSegs?.length || !toSegs?.length) {
      return fail(c, "Invalid path", 400);
    }
    const fromPath = fromSegs.join("/");
    const toPath = toSegs.join("/");
    if (fromPath === toPath) return ok(c, { path: toPath });

    const kv = c.env.oh_file_url;
    try {
      // 目标不能与已有文件/目录冲突
      if (await dirExists(kv, fileType, toPath)) {
        return fail(c, "Target folder already exists", 409);
      }
      if (await findFileByName(kv, toPath, fileType)) {
        return fail(c, "Target file already exists", 409);
      }
      // 父目录必须存在
      const parent = toSegs.slice(0, -1).join("/");
      if (parent && !(await dirExists(kv, fileType, parent))) {
        return fail(c, "Parent folder not found", 404);
      }

      if (!isDir) {
        // 文件：key 与路径无关，仅改写 metadata.fileName
        const found = await findFileByName(kv, fromPath, fileType);
        if (!found) return fail(c, "File not found", 404);
        await kv.put(found.key, "", {
          metadata: { ...found.metadata, fileName: toPath },
        });
        return ok(c, { path: toPath });
      }

      // 目录：重写该前缀下全部条目（目录标记换 key，文件改 metadata）
      if (!(await dirExists(kv, fileType, fromPath))) {
        return fail(c, "Folder not found", 404);
      }
      // 防止把目录移动到自身内部（a → a/b）
      if (toPath.startsWith(`${fromPath}/`)) {
        return fail(c, "Cannot move a folder into itself", 400);
      }

      const oldPrefix = `${fromPath}/`;
      const newPrefix = `${toPath}/`;
      let movedFiles = 0;
      let movedDirs = 0;
      for (const item of await listAllOfType(kv, fileType)) {
        const md = item.metadata;
        if (!md) continue;
        const name = md.fileName ?? "";
        if (md.isDir) {
          if (name !== fromPath && !name.startsWith(oldPrefix)) continue;
          const newName =
            name === fromPath
              ? toPath
              : newPrefix + name.slice(oldPrefix.length);
          // 关键：metadata.fileName 必须同步改写，否则 dirExists/列表/搜索会看到幽灵目录
          await kv.put(dirMarkerKey(fileType, newName), "", {
            metadata: { ...md, fileName: newName },
          });
          await kv.delete(item.name);
          movedDirs += 1;
        } else {
          if (!name.startsWith(oldPrefix)) continue;
          await kv.put(item.name, "", {
            metadata: {
              ...md,
              fileName: newPrefix + name.slice(oldPrefix.length),
            },
          });
          movedFiles += 1;
        }
      }
      return ok(c, { path: toPath, movedFiles, movedDirs });
    } catch (err) {
      console.error("[browser:rename] error:", err);
      return fail(c, "Failed to rename");
    }
  }
);

// ---------- 4. 全局搜索（跨四种类型，含目录） ----------

export type SearchResultItem =
  | { kind: "dir"; type: FileType; path: string; uploadedAt: number }
  | { kind: "file"; type: FileType; path: string; item: FileItem };

browserRoutes.get(
  "/search",
  authMiddleware,
  zValidator(
    "query",
    z.object({
      q: z.string().min(1).max(200),
      limit: z
        .string()
        .optional()
        .transform((v) =>
          v ? Math.min(Math.max(parseInt(v, 10) || 50, 1), 200) : 50
        ),
    })
  ),
  async (c) => {
    const { q, limit } = c.req.valid("query");
    const kv = c.env.oh_file_url;
    const needle = q.trim().toLowerCase();

    const results: SearchResultItem[] = [];
    let total = 0;
    const all: SearchResultItem[] = [];

    try {
      for (const { type } of TYPE_DIRS) {
        for (const item of await listAllOfType(kv, type)) {
          const md = item.metadata;
          if (!md) continue;
          const name = md.fileName ?? "";
          if (md.isDir) {
            if (!name.toLowerCase().includes(needle)) continue;
            all.push({
              kind: "dir",
              type,
              path: name,
              uploadedAt: md.uploadedAt ?? 0,
            });
            total += 1;
          } else {
            if (!isCompleteFile(md)) continue;
            const nameHit = name.toLowerCase().includes(needle);
            const desc = md.desc?.toLowerCase() ?? "";
            const tagText = (md.tags || []).join(" ").toLowerCase();
            if (
              !nameHit &&
              !(
                needle.length >= 2 &&
                (desc.includes(needle) || tagText.includes(needle))
              )
            ) {
              continue;
            }
            all.push({ kind: "file", type, path: name, item });
            total += 1;
          }
        }
      }

      const ts = (r: SearchResultItem) =>
        r.kind === "dir" ? r.uploadedAt : (r.item.metadata?.uploadedAt ?? 0);
      all.sort((a, b) => ts(b) - ts(a));
      results.push(...all.slice(0, limit));
      return ok(c, { results, total });
    } catch (err) {
      console.error("[browser:search] error:", err);
      return fail(c, "Search failed");
    }
  }
);

// ---------- 6. 删除（文件进回收站；目录默认仅空目录，recursive 支持递归） ----------

const deleteSchema = z.object({
  fileType: z.enum(FileType),
  path: z.string().min(1).max(MAX_PATH_LENGTH),
  isDir: z.boolean(),
  recursive: z.boolean().optional().default(false),
});

browserRoutes.post(
  "/delete",
  authMiddleware,
  async (c: Context<{ Bindings: Env }>) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, "Invalid JSON body", 400);
    }
    const parsed = deleteSchema.safeParse(raw);
    if (!parsed.success) return fail(c, "Invalid parameters", 400);
    const { fileType, path, isDir, recursive } = parsed.data;
    const segs = validateRelPath(path);
    if (!segs?.length) return fail(c, "Invalid path", 400);
    const dirPath = segs.join("/");

    const kv = c.env.oh_file_url;
    const db = DBAdapterFactory.getAdapter(c.env);
    const origin = new URL(c.req.url).origin;

    try {
      if (!isDir) {
        const found = await findFileByName(kv, dirPath, fileType);
        if (!found) return fail(c, "File not found", 404);
        await db.moveToTrash(found.key);
        c.executionCtx.waitUntil(
          deleteFileCache(origin, found.key).catch(() => {})
        );
        return ok(c, { deleted: dirPath });
      }

      // 目录：默认与 WebDAV DELETE 语义一致（仅空目录）；recursive 时内容进回收站
      if (!(await dirExists(kv, fileType, dirPath))) {
        return fail(c, "Folder not found", 404);
      }
      const prefix = `${dirPath}/`;
      let removedMarkers = 0;
      let trashedFiles = 0;
      const cacheKeys: string[] = [];
      for (const item of await listAllOfType(kv, fileType)) {
        const md = item.metadata;
        if (!md) continue;
        const name = md.fileName ?? "";
        if (md.isDir) {
          if (name === dirPath || name.startsWith(prefix)) {
            if (!recursive) {
              await kv.delete(item.name);
            }
            removedMarkers += 1;
          }
        } else if (name.startsWith(prefix) && isCompleteFile(md)) {
          if (!recursive) {
            return fail(c, "Folder not empty", 409);
          }
          await db.moveToTrash(item.name);
          cacheKeys.push(item.name);
          trashedFiles += 1;
        }
      }
      if (recursive) {
        // 递归模式：先全部移入回收站成功，再删除目录标记
        for (const item of await listAllOfType(kv, fileType)) {
          const md = item.metadata;
          if (!md?.isDir) continue;
          const name = md.fileName ?? "";
          if (name === dirPath || name.startsWith(prefix)) {
            await kv.delete(item.name).catch(() => {});
          }
        }
      }
      if (cacheKeys.length) {
        c.executionCtx.waitUntil(
          Promise.all(
            cacheKeys.map((k) => deleteFileCache(origin, k).catch(() => {}))
          )
        );
      }
      return ok(c, { deleted: dirPath, removedMarkers, trashedFiles });
    } catch (err) {
      console.error("[browser:delete] error:", err);
      return fail(c, "Failed to delete");
    }
  }
);

// ---------- 5. 上传到指定目录 ----------

browserRoutes.post(
  "/upload",
  authMiddleware,
  async (c: Context<{ Bindings: Env }>) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      return fail(c, "Invalid multipart body", 400);
    }

    const file = body.file;
    if (!(file instanceof File)) {
      return fail(c, "Missing file field", 400);
    }
    const fileType = (body.fileType as string) || "";
    const entry = TYPE_DIRS.find((d) => d.type === fileType);
    if (!entry) return fail(c, "Invalid fileType", 400);

    const dirPath = ((body.path as string) || "").trim();
    const dirSegs = validateRelPath(dirPath);
    if (dirSegs === null) return fail(c, "Invalid path", 400);

    // 文件名取 basename，拼接目标目录
    const baseName = (file.name || "unnamed").split("/").pop() ?? "unnamed";
    const segs = validateRelPath(baseName);
    if (!segs || segs.length !== 1) return fail(c, "Invalid file name", 400);
    const fileName = dirSegs.length
      ? `${dirSegs.join("/")}/${baseName}`
      : baseName;

    if (file.size > MAX_FILE_SIZE) {
      return fail(c, "File too large (use WebDAV for >1GB files)", 413);
    }

    const kv = c.env.oh_file_url;
    const db = DBAdapterFactory.getAdapter(c.env);

    try {
      // 目标目录必须存在（隐式目录也算，WebDAV PUT 允许隐式创建，这里保持一致放宽）
      // 覆盖语义：同名旧文件移入回收站
      const existing = await findFileByName(kv, fileName, entry.type);
      if (existing) {
        await db.moveToTrash(existing.key);
        const origin = new URL(c.req.url).origin;
        c.executionCtx.waitUntil(
          deleteFileCache(origin, existing.key).catch(() => {})
        );
      }

      const mime = file.type || getContentTypeByExt(getFileExt(fileName));
      let key: string;
      if (file.size <= MAX_CHUNK_SIZE) {
        const res = await putSmall(c, fileName, mime, await file.arrayBuffer());
        key = res.key;
      } else {
        // 大文件：内存切片走分片通道（multipart 上限 100MB）
        const totalChunks = Math.ceil(file.size / MAX_CHUNK_SIZE);
        key = await initChunkedKey(
          kv,
          entry.type,
          fileName,
          file.size,
          totalChunks
        );
        let off = 0;
        for (let i = 0; i < totalChunks; i++) {
          const end = Math.min(off + MAX_CHUNK_SIZE, file.size);
          const part = file.slice(off, end);
          await db.uploadChunk(key, i, part);
          off = end;
        }
      }
      return ok(c, { key, fileName });
    } catch (err) {
      console.error("[browser:upload] error:", err);
      return fail(c, "Upload failed", 500);
    }
  }
);
