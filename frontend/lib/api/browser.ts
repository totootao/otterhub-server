import { API_URL, unwrap } from "./config";
import { FileItem, FileType } from "@shared/types";

// ==========================================
// 文件浏览器 API（文件夹视图 + 全局搜索）
// 与 WebDAV 共用同一套目录模型
// ==========================================

export type BrowserDirEntry = {
  kind: "dir";
  name: string;
  uploadedAt: number;
};

export type BrowserFileEntry = {
  kind: "file";
  item: FileItem;
};

export type BrowserEntry = BrowserDirEntry | BrowserFileEntry;

export type GlobalSearchResult =
  | { kind: "dir"; type: FileType; path: string; uploadedAt: number }
  | { kind: "file"; type: FileType; path: string; item: FileItem };

/** 列出目录内容（path 为相对类型根的路径，"" 表示根） */
export async function listBrowserDir(
  fileType: FileType,
  path = ""
): Promise<{ entries: BrowserEntry[] }> {
  const res = await fetch(
    `${API_URL}/file/browser/list?fileType=${fileType}&path=${encodeURIComponent(path)}`,
    { credentials: "include" }
  );
  return unwrap(res);
}

/** 新建文件夹 */
export async function mkdirBrowser(
  fileType: FileType,
  path: string
): Promise<{ path: string }> {
  const res = await fetch(`${API_URL}/file/browser/mkdir`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ fileType, path }),
  });
  return unwrap(res);
}

/** 重命名 / 同类型内移动（文件 O(1)，目录批量改写前缀） */
export async function renameBrowser(
  fileType: FileType,
  from: string,
  to: string,
  isDir: boolean
): Promise<{ path: string }> {
  const res = await fetch(`${API_URL}/file/browser/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ fileType, from, to, isDir }),
  });
  return unwrap(res);
}

/** 删除：文件进回收站；目录默认仅空目录，recursive=true 递归删除（内容进回收站） */
export async function deleteBrowser(
  fileType: FileType,
  path: string,
  isDir: boolean,
  recursive = false
): Promise<{ deleted: string }> {
  const res = await fetch(`${API_URL}/file/browser/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ fileType, path, isDir, recursive }),
  });
  return unwrap(res);
}

/** 全局搜索（跨四种类型，匹配文件名/描述/标签，含目录） */
export async function globalSearch(
  q: string,
  limit = 50
): Promise<{ results: GlobalSearchResult[]; total: number }> {
  const res = await fetch(
    `${API_URL}/file/browser/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    { credentials: "include" }
  );
  return unwrap(res);
}

/** 上传文件到指定目录（multipart，走与 WebDAV PUT 相同的落库通道） */
export function uploadToDir(
  file: File,
  fileType: FileType,
  path: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<{ key: string; fileName: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file);
    form.append("fileType", fileType);
    if (path) form.append("path", path);

    xhr.open("POST", `${API_URL}/file/browser/upload`);
    xhr.withCredentials = true;

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
    }
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300 && body.success) {
          resolve(body.data);
        } else {
          reject(new Error(body.message || `上传失败 (HTTP ${xhr.status})`));
        }
      } catch {
        reject(new Error(`上传失败 (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("网络错误，上传失败"));
    xhr.send(form);
  });
}
