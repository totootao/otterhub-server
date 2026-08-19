import { BlobReader, ZipWriter, configure } from "@zip.js/zip.js";

import { BundleFileInfo, MAX_FILENAME_LENGTH } from "@shared/types";
import { encodeContentDisposition } from "./common";

configure({
  useCompressionStream: false,
});

export function sanitizeArchiveName(name: string): string {
  const trimmed = name.trim();
  const withoutExt = trimmed.replace(/\.zip$/i, "");
  const sanitized = withoutExt
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .slice(0, MAX_FILENAME_LENGTH);

  return sanitized || "otterhub-batch";
}

export function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\]/g, "_")
    .replace(/[<>:"|?*\x00-\x1F]/g, "")
    .slice(0, MAX_FILENAME_LENGTH);
}

export async function createZipDownloadResponse(
  files: BundleFileInfo[],
  db: { get: (key: string, req?: Request) => Promise<Response> },
  requestUrl: string,
  archiveName: string,
): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const zipWriter = new ZipWriter(writable);

  (async () => {
    try {
      for (const fileInfo of files) {
        try {
          const resp = await db.get(fileInfo.key, new Request(requestUrl));
          if (!resp.ok) continue;

          const blob = await resp.blob();
          const safeFileName = sanitizeFileName(fileInfo.name);
          await zipWriter.add(safeFileName, new BlobReader(blob));
        } catch (error) {
          console.error(`Failed to fetch file ${fileInfo.name}:`, error);
        }
      }
      await zipWriter.close();
    } catch (error) {
      console.error("ZIP creation error:", error);
    }
  })();

  const safeArchiveName = sanitizeArchiveName(archiveName);

  return new Response(readable, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": encodeContentDisposition(`${safeArchiveName}.zip`, false),
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}
