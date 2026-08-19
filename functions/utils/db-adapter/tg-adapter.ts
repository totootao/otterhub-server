import { BaseAdapter } from "./base-adapter";
import { failResponse } from "@utils/response";
import { encodeContentDisposition } from "../common";
import {
  buildKeyId,
  getFileIdFromKey,
  getContentTypeByExt,
  getFileTypeByMimeOrExt,
} from "../file";
import {
  getTgPool,
  getTgSlot,
  pickTgSlotIndex,
  pickChunkSlotIndex,
  recordTgError,
  resolveTgFilePath,
  sleep,
} from "../tg-pool";

import {
  FileMetadata,
  ApiResponse,
  Chunk,
  FileType,
  GeneralSettings,
} from "@shared/types";
import {
  parseRangeHeader,
  sortChunksAndCalculateSize,
  validateChunksForMerge,
} from "./shared-utils";
import {
  getTgFileId,
  getTgImageVariantIds,
  getTgFileSize,
  getVideoThumbId,
  resolveFileDescriptor,
  buildTgApiUrl,
  buildTgFileUrl,
  processGifFile,
} from "./tg-tools";
import { tgFetch } from "../tg-proxy";

import { MAX_CHUNK_SIZE } from "@shared/types";
import { analyzeImageAndEnrich, isSupportedImage } from "../ai/image-analysis";
import { kvGetJSON } from "@utils/kv";
import { CF } from "types";

// Telegram存储适配器实现
export class TGAdapter extends BaseAdapter {
  constructor(env: any, kvName: string) {
    super(env, kvName);
  }

  private async getCachedTgFilePath(
    fileId: string,
    forceRefresh: boolean = false,
    preferSlot?: number
  ): Promise<string | null> {
    const resolved = await resolveTgFilePath(this.env, fileId, {
      preferSlot,
      forceRefresh,
    });
    return resolved?.filePath ?? null;
  }

  async uploadFile(
    file: File | Blob | Uint8Array,
    metadata: FileMetadata,
    waitUntil?: (p: Promise<any>) => void
  ): Promise<{ key: string }> {
    if (metadata.fileSize > MAX_CHUNK_SIZE) {
      throw new Error(`File size exceeds ${MAX_CHUNK_SIZE}MB`);
    }

    const { fileName } = metadata;

    // 空文件：Telegram 拒绝 0 字节上传（"file must be non-empty"），
    // 改传 1 字节占位并在 metadata 打标，get() 时短路返回空内容
    const isEmpty = metadata.fileSize === 0;
    if (isEmpty) {
      const ext = fileName.split(".").pop()?.toLowerCase() || "";
      const mime = getContentTypeByExt(ext);
      // 类型按扩展名推导，与常规路径一致，保证文件出现在对应类型目录列表中
      const fileType = getFileTypeByMimeOrExt(mime, ext);
      const placeholder = new File([new Uint8Array([0x20])], fileName, {
        type: mime,
      });
      const formData = new FormData();
      formData.append("document", placeholder);
      const result = await this.sendToTelegram(
        formData,
        "sendDocument",
        3,
        pickTgSlotIndex(getTgPool(this.env).length)
      );
      if (!result.success) {
        throw new Error(result.message);
      }
      const tgFileId = getTgFileId(result.data);
      if (!tgFileId) {
        throw new Error("Failed to extract Telegram file_id for empty file");
      }
      const key = buildKeyId(fileType, tgFileId, ext);
      metadata.emptyFile = true;
      metadata.fileSize = 0; // 逻辑大小保持 0（TG 返回的实际 1 字节不覆盖）
      metadata.tgSlot = result.slotIndex; // file_id 与 bot 绑定，记录槽位供下载使用
      const kv = this.env[this.kvName];
      if (kv) {
        await kv.put(key, "", { metadata });
      }
      return { key };
    }

    // 如果不是 File 实例，将其转换为 File
    let finalFile: File;
    if (file instanceof File) {
      finalFile = file;
    } else {
      const extension = fileName.split(".").pop()?.toLowerCase() || "";
      const contentType = getContentTypeByExt(extension);
      finalFile = new File([file as unknown as BlobPart], fileName, {
        type: contentType,
      });
    }

    const { file: processedFile, fileName: processedFileName } =
      await processGifFile(finalFile, fileName);

    const { apiEndpoint, field, fileType, ext } = resolveFileDescriptor(
      processedFile,
      processedFileName
    );

    const formData = new FormData();
    formData.append(field, processedFile);

    // 多 Bot 池：秒级时间片轮询选槽，429 时由 sendToTelegram 自动换槽重试
    const result = await this.sendToTelegram(
      formData,
      apiEndpoint,
      3,
      pickTgSlotIndex(getTgPool(this.env).length)
    );
    if (!result.success) {
      throw new Error(result.message);
    }

    const imageVariantIds =
      fileType === FileType.Image
        ? getTgImageVariantIds(result.data)
        : { fileId: null, previewFileId: null };

    const tgFileId = imageVariantIds.fileId ?? getTgFileId(result.data);
    if (!tgFileId) {
      throw new Error("Failed to extract Telegram file_id");
    }

    // 使用 Telegram 返回的实际文件大小（sendPhoto 会压缩图片）
    const actualFileSize = getTgFileSize(result.data);
    if (actualFileSize !== undefined) {
      metadata.fileSize = actualFileSize;
    }

    // 图片和视频都尽量复用 Telegram 返回的小图能力
    if (fileType === FileType.Image && imageVariantIds.previewFileId) {
      metadata.thumbUrl = `/file/${imageVariantIds.previewFileId}/thumb`;
    }
    if (fileType === FileType.Video) {
      const thumbFileId = getVideoThumbId(result.data);
      if (thumbFileId) {
        metadata.thumbUrl = `/file/${thumbFileId}/thumb`;
      }
    }

    const key = buildKeyId(fileType, tgFileId, ext);
    metadata.tgSlot = result.slotIndex; // file_id 与 bot 绑定，记录槽位供下载使用

    const kv = this.env[this.kvName];
    if (kv) {
      await kv.put(key, "", { metadata });
    }

    // 图片上传成功后根据全局设置决定是否异步触发 AI 分析，优先使用 Telegram 返回的小图
    if (
      kv &&
      fileType === FileType.Image &&
      isSupportedImage(processedFile.type, processedFileName)
    ) {
      let enableImageAnalysis = true;
      try {
        const settings = await kvGetJSON<Partial<GeneralSettings>>(
          kv,
          CF.SETTINGS_KEY,
          {
            enableImageAnalysis: true,
          }
        );
        enableImageAnalysis = settings.enableImageAnalysis !== false;
      } catch (err) {
        console.warn(
          "[AI] Failed to read image analysis setting, using default enabled:",
          err
        );
      }

      if (enableImageAnalysis) {
        const enrichTask = analyzeImageAndEnrich(
          this.env,
          kv,
          key,
          processedFile,
          {
            previewFileId: imageVariantIds.previewFileId,
            tgFileId: tgFileId,
            tgSlot: result.slotIndex,
          }
        );
        if (waitUntil) {
          waitUntil(enrichTask);
        } else {
          enrichTask.catch((err) =>
            console.warn("[AI] Background enrich failed:", err)
          );
        }
      }
    }

    return { key };
  }

  async uploadStream(
    stream: ReadableStream,
    metadata: FileMetadata,
    waitUntil?: (p: Promise<any>) => void,
    mimeType?: string
  ): Promise<{ key: string }> {
    // Telegram 不支持流式上传，需要转为 Blob
    const response = new Response(stream);
    const blob = await response.blob();
    // 如果提供了 mimeType，创建带类型的 Blob
    const typedBlob = mimeType ? new Blob([blob], { type: mimeType }) : blob;
    return this.uploadFile(typedBlob, metadata, waitUntil);
  }

  /**
   * 上传分片到 Telegram 存储
   * 由基类的 consumeChunk 模板方法调用
   * 多 Bot 池：同一文件内按分片序号轮询槽位（0→bot0, 1→bot1...），最大化分摊流控
   */
  protected async uploadToTarget(
    chunkFile: File | Blob | Uint8Array,
    parentKey: string,
    chunkIndex: number,
    fileName?: string
  ): Promise<{ chunkId: string; thumbUrl?: string; slot: number }> {
    const formData = new FormData();

    // 确保是 File 实例以便带有文件名
    let fileToUpload: File;
    if (chunkIndex === 0 && fileName) {
      // 如果是第一个分片且有文件名，使用原文件名以帮助Telegram识别文件类型（如视频）
      const blob =
        chunkFile instanceof File
          ? chunkFile
          : new Blob([chunkFile as unknown as BlobPart]);
      const type = chunkFile instanceof File ? chunkFile.type : undefined;
      fileToUpload = new File([blob], fileName, { type });
    } else if (chunkFile instanceof File) {
      fileToUpload = chunkFile;
    } else {
      fileToUpload = new File(
        [chunkFile as unknown as BlobPart],
        `part-${chunkIndex}`
      );
    }

    formData.append("document", fileToUpload);

    const result = await this.sendToTelegram(
      formData,
      "sendDocument",
      3,
      pickChunkSlotIndex(getTgPool(this.env).length, chunkIndex)
    );
    if (!result.success) {
      throw new Error(
        `Chunk ${chunkIndex} upload failed: ${result.message || "Unknown error"}`
      );
    }

    const chunkId = result.data.result.document.file_id;
    let thumbUrl: string | undefined;

    // 尝试获取缩略图
    if (chunkIndex === 0) {
      const thumbFileId = getVideoThumbId(result.data);
      if (thumbFileId) {
        thumbUrl = `/file/${thumbFileId}/thumb`;
      }
    }

    return { chunkId, thumbUrl, slot: result.slotIndex };
  }

  async get(key: string, req?: Request): Promise<Response> {
    const { fileId, isChunk } = getFileIdFromKey(key);
    const kv = this.env[this.kvName];
    // 优先获取 Metadata 判断文件类型
    const { value, metadata } = await kv.getWithMetadata(key);

    if (!metadata) {
      return failResponse(`Metadata not found for key: ${key}`, 404);
    }

    // 空文件短路：物理存储是 1 字节占位，直接返回空内容（不回源 TG）
    if (metadata.emptyFile) {
      const ext = key.substring(key.lastIndexOf(".") + 1);
      const headers = new Headers();
      headers.set("Content-Type", getContentTypeByExt(ext));
      headers.set(
        "Content-Disposition",
        encodeContentDisposition(metadata.fileName)
      );
      headers.set("Accept-Ranges", "bytes");
      const range = req?.headers.get("Range");
      if (range) {
        // 0 字节文件无法满足任何 bytes 区间
        headers.set("Content-Range", "bytes */0");
        return new Response(null, { status: 416, headers });
      }
      return new Response(null, { status: 200, headers });
    }

    // 检查是否为分片合并文件（依据 metadata.chunkInfo）
    if (metadata.chunkInfo && isChunk) {
      return await this.getMergedFile(key, req, metadata, value);
    }

    return await this.getSingleFile(key, req, metadata);
  }

  /**
   * 获取单个文件
   */
  private async getSingleFile(
    key: string,
    req: Request | undefined,
    metadata: FileMetadata
  ): Promise<Response> {
    try {
      const { fileId } = getFileIdFromKey(key);
      const ext = key.substring(key.lastIndexOf(".") + 1);
      const contentType = getContentTypeByExt(ext);

      // 按上传时记录的槽位解析（旧数据无 tgSlot → 探测主 bot 及其余槽位）
      let resolved = await resolveTgFilePath(this.env, fileId, {
        preferSlot: metadata.tgSlot,
      });
      if (!resolved) {
        return failResponse(`File not found for key: ${key}`, 404);
      }
      const slot = getTgSlot(this.env, resolved.slot);
      if (!slot) {
        return failResponse(`File not found for key: ${key}`, 404);
      }

      const headers = new Headers();
      headers.set("Content-Type", contentType);
      headers.set(
        "Content-Disposition",
        encodeContentDisposition(metadata.fileName)
      );
      headers.set("Cache-Control", "public, max-age=3600");
      headers.set("Accept-Ranges", "bytes");

      const range = req?.headers.get("Range") || null;

      const fetchFromTg = async (currentFilePath: string) => {
        const tgUrl = buildTgFileUrl(slot!.token, currentFilePath);
        return range
          ? tgFetch(tgUrl, { headers: { Range: range } })
          : tgFetch(tgUrl);
      };

      let tgResp = await fetchFromTg(resolved.filePath);

      // Telegram 链接有效期 1 小时，如遇 401/404 错误则强制刷新缓存并重试一次
      if (tgResp.status === 401 || tgResp.status === 404) {
        console.log(
          `[TGAdapter] TG URL expired or invalid (Status: ${tgResp.status}). Retrying for key: ${key}`
        );
        const refreshed = await resolveTgFilePath(this.env, fileId, {
          preferSlot: metadata.tgSlot,
          forceRefresh: true,
        });
        if (!refreshed) {
          return failResponse(
            `File not found for key: ${key} after retry`,
            404
          );
        }
        resolved = refreshed;
        const refreshedSlot = getTgSlot(this.env, resolved.slot);
        if (!refreshedSlot) {
          return failResponse(`File not found for key: ${key}`, 404);
        }
        const refreshedUrl = buildTgFileUrl(
          refreshedSlot.token,
          resolved.filePath
        );
        tgResp = await (range
          ? tgFetch(refreshedUrl, { headers: { Range: range } })
          : tgFetch(refreshedUrl));
      }

      if (range) {
        const contentRange = tgResp.headers.get("Content-Range");
        const contentLength = tgResp.headers.get("Content-Length");

        if (contentRange) headers.set("Content-Range", contentRange);
        if (contentLength) headers.set("Content-Length", contentLength);

        return new Response(tgResp.body, {
          status: tgResp.status,
          headers,
        });
      }

      const contentLength = tgResp.headers.get("Content-Length");
      if (contentLength) headers.set("Content-Length", contentLength);

      return new Response(tgResp.body, { status: tgResp.status, headers });
    } catch (error) {
      return failResponse(`File not found for key: ${key}`, 404);
    }
  }

  /**
   * 合并分片文件
   */
  private async getMergedFile(
    key: string,
    req: Request | undefined,
    metadata: FileMetadata,
    value: string | ReadableStream | ArrayBuffer | null
  ): Promise<Response> {
    const ext = key.substring(key.lastIndexOf(".") + 1);
    const contentType = getContentTypeByExt(ext);

    if (!metadata.chunkInfo) {
      return failResponse("Invalid metadata: not a chunked file", 400);
    }

    // 解析 chunks
    let chunks: Chunk[] = [];
    try {
      if (value) {
        chunks = JSON.parse(value as string);
      }
    } catch (e) {
      console.error(`[TGAdapter] Failed to parse chunks for ${key}:`, e);
      return failResponse("Failed to parse chunks metadata", 500);
    }

    // 验证分片完整性
    const validation = validateChunksForMerge(chunks, metadata.chunkInfo.total);
    if (!validation.valid) {
      console.error(`[getMergedFile] ${validation.reason}`);
      return failResponse(validation.reason || "Invalid metadata", 425);
    }

    // 排序并计算总大小
    const { sortedChunks, totalSize } = sortChunksAndCalculateSize(chunks);

    // 解析 Range 请求
    const rangeResult = parseRangeHeader(
      req?.headers.get("Range") || null,
      totalSize
    );

    // 计算实际响应的字节范围
    const start = rangeResult ? rangeResult.start : 0;
    const end = rangeResult ? rangeResult.end : totalSize - 1;

    // 准备上下文（多 Bot 池：每个分片按各自上传槽位解析路径与 token）
    const getChunkToken = (slotIndex?: number) =>
      getTgSlot(this.env, slotIndex)?.token ?? "";
    const getFilePath = (
      fileId: string,
      forceRefresh = false,
      preferSlot?: number
    ) => this.getCachedTgFilePath(fileId, forceRefresh, preferSlot);

    // 创建连续流
    const stream = new ReadableStream({
      async start(controller) {
        try {
          let currentOffset = 0;
          let fetchPromise: Promise<Response> | null = null;
          let nextChunkIdx = -1;

          // 找到起始分片索引
          let startChunkIdx = 0;
          for (let i = 0; i < sortedChunks.length; i++) {
            const chunk = sortedChunks[i];
            const chunkEnd = currentOffset + chunk.size;
            if (chunkEnd > start) {
              startChunkIdx = i;
              break;
            }
            currentOffset += chunk.size;
          }

          // 预读取第一个分片
          if (startChunkIdx < sortedChunks.length) {
            nextChunkIdx = startChunkIdx;
          }

          // 循环处理分片
          for (let i = startChunkIdx; i < sortedChunks.length; i++) {
            const chunk = sortedChunks[i];
            const chunkStart = currentOffset;
            const chunkEnd = currentOffset + chunk.size;

            // 如果当前分片已经超出请求范围，停止
            if (chunkStart > end) break;

            // 触发当前分片的请求（如果还没触发）
            // 或者如果已经有预读取的 promise，使用它
            let response: Response;

            // 预读取逻辑：始终保持 fetchPromise 是下一个要处理的请求
            // 在处理当前分片的同时，启动下一个分片的请求
            // 注意：分片字节边界必须作为参数显式传入，不能用闭包捕获循环变量——
            // 预取下一分片时闭包里的 chunkStart/chunkEnd 仍是当前分片的值，
            // 会按错误的坐标系计算 Range，导致跨分片请求返回错误字节
            const fetchChunk = async (
              c: Chunk,
              cStart: number,
              cEnd: number,
              forceRefresh = false
            ) => {
              const filePath = await getFilePath(
                c.file_id,
                forceRefresh,
                c.slot
              );
              if (!filePath) throw new Error(`Missing chunk ${c.idx}`);
              const url = buildTgFileUrl(getChunkToken(c.slot), filePath);

              // 计算该分片内的请求范围，并转换为相对于该分片的 Range
              const reqStart = Math.max(cStart, start);
              const reqEnd = Math.min(cEnd, end + 1);
              const relativeStart = reqStart - cStart;
              const relativeEnd = reqEnd - cStart;

              // 始终使用 Range 请求以减少带宽消耗 (TG API range 包含边界值)
              const headers: HeadersInit = {
                Range: `bytes=${relativeStart}-${relativeEnd - 1}`,
              };

              return tgFetch(url, { headers });
            };

            if (!fetchPromise) {
              fetchPromise = fetchChunk(chunk, chunkStart, chunkEnd);
            }

            response = await fetchPromise;
            fetchPromise = null; // 消费掉

            // Telegram 链接有效期 1 小时，如遇 401/404 错误则强制刷新缓存并重试一次
            if (response.status === 401 || response.status === 404) {
              console.log(
                `[TGAdapter] Chunk ${chunk.idx} URL expired (Status: ${response.status}). Retrying...`
              );
              response = await fetchChunk(chunk, chunkStart, chunkEnd, true);
            }

            // 立即启动下一个分片的预读取
            if (i + 1 < sortedChunks.length) {
              const nextChunk = sortedChunks[i + 1];
              const nextChunkStart = chunkEnd;
              // 仅当下一个分片在请求范围内时才预读
              if (nextChunkStart <= end) {
                fetchPromise = fetchChunk(
                  nextChunk,
                  nextChunkStart,
                  nextChunkStart + nextChunk.size
                );
              }
            }

            if (!response.ok || !response.body) {
              throw new Error(`Failed to fetch chunk ${chunk.idx}`);
            }

            // 流式传输当前分片数据
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }

            currentOffset += chunk.size;
          }

          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    const hasRange = Boolean(req?.headers.get("Range"));

    return new Response(stream, {
      status: hasRange ? 206 : 200,
      headers: {
        "Content-Type": contentType,
        ...(hasRange
          ? { "Content-Range": `bytes ${start}-${end}/${totalSize}` }
          : {}),
        "Content-Length": String(end - start + 1),
        "Content-Disposition": encodeContentDisposition(metadata.fileName),
        "Cache-Control": "public, max-age=3600",
        "Accept-Ranges": "bytes",
      },
    });
  }

  async delete(key: string): Promise<{ isDeleted: boolean }> {
    try {
      // Telegram API不支持直接删除文件
      // 只从KV存储中删除文件信息
      await this.env[this.kvName].delete(key);

      return { isDeleted: true };
    } catch (error) {
      return { isDeleted: false };
    }
  }

  // https://core.telegram.org/bots/api#sending-files
  /**
   * 统一 Telegram 上传通道（多 Bot 池感知）
   *
   * - 每次尝试都会把 formData 的 chat_id 绑定为当前槽位的 chatId
   * - 429 流控：优先切换到未尝试过的槽位立即重试（不消耗重试次数）；
   *   所有槽位都限流后再退避重试（尊重 retry_after）
   * - 其他失败：指数退避 + 轮转到下一槽位重试
   * - sendPhoto 失败降级为 sendDocument 的逻辑保持不变
   * - 单次请求 60s 超时
   *
   * @returns 成功时携带实际使用的 slotIndex（写入 metadata.tgSlot / chunk.slot）
   */
  private async sendToTelegram(
    formData: FormData,
    apiEndpoint: string,
    retryCount = 3,
    slotIndex = 0,
    visitedSlots: number[] = []
  ): Promise<ApiResponse<any> & { slotIndex: number }> {
    const pool = getTgPool(this.env);
    if (!pool.length) {
      return {
        success: false,
        slotIndex: 0,
        message: "TG bot pool not configured (TG_BOT_POOLS / TG_BOT_TOKEN)",
      };
    }
    const idx = ((slotIndex % pool.length) + pool.length) % pool.length;
    const slot = pool[idx];
    const apiUrl = buildTgApiUrl(slot.token, apiEndpoint);

    // chat_id 必须与 bot 槽位匹配（每个 bot 只能向自己所在的 chat 发送）
    formData.set("chat_id", slot.chatId);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await tgFetch(apiUrl, {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const responseData = await response.json();

      if (response.ok) {
        return { success: true, data: responseData, slotIndex: idx };
      }

      const isRateLimit =
        response.status === 429 || responseData?.error_code === 429;
      const attempt = 3 - retryCount;
      const backoffMs = Math.min(30000, Math.pow(2, attempt) * 1000);
      const retryAfterSec =
        typeof responseData?.parameters?.retry_after === "number"
          ? responseData.parameters.retry_after
          : undefined;
      const waitMs =
        retryAfterSec !== undefined
          ? Math.max(backoffMs, retryAfterSec * 1000)
          : backoffMs;

      // 诊断：TG API 非 200 全量记录到 KV 环形日志（GET /telegram/pool/errors 查看）
      void recordTgError(this.env, {
        op: apiEndpoint,
        slot: idx,
        code: responseData?.error_code ?? response.status,
        desc: String(responseData?.description || "").slice(0, 120),
        ra: retryAfterSec,
      });

      // 流控且池中还有未尝试的槽位：换槽重试，不消耗重试次数
      if (isRateLimit) {
        const nextVisited = [...visitedSlots, idx];
        const unvisited = pool
          .map((_, i) => i)
          .filter((i) => !nextVisited.includes(i));
        if (unvisited.length > 0) {
          console.warn(
            `[TGAdapter] Rate limited on slot ${idx}, switching to slot ${unvisited[0]}`
          );
          await sleep(Math.min(waitMs, 1500));
          return this.sendToTelegram(
            formData,
            apiEndpoint,
            retryCount,
            unvisited[0],
            nextVisited
          );
        }
      }

      // 图片类型特殊处理：转为文档方式重试
      if (retryCount > 0) {
        if (apiEndpoint === "sendPhoto") {
          const newFormData = new FormData();
          newFormData.append("document", formData.get("photo") as File);
          await sleep(waitMs);
          return this.sendToTelegram(
            newFormData,
            "sendDocument",
            retryCount - 1,
            idx
          );
        }
        // 其他类型：退避后轮转到下一槽位重试
        await sleep(waitMs);
        return this.sendToTelegram(
          formData,
          apiEndpoint,
          retryCount - 1,
          idx + 1
        );
      }

      return {
        success: false,
        slotIndex: idx,
        message: `Upload to Telegram failed: ${
          responseData.description || "Unknown error"
        }`,
      };
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (retryCount > 0) {
        const isAbort = error?.name === "AbortError";
        const backoffMs = isAbort
          ? 2000
          : Math.min(30000, Math.pow(2, 3 - retryCount) * 1000);
        await sleep(backoffMs);
        return this.sendToTelegram(
          formData,
          apiEndpoint,
          retryCount - 1,
          idx + 1
        );
      }
      return {
        success: false,
        slotIndex: idx,
        message: `Network error occurred: ${
          error?.message || "Unknown network error"
        }`,
      };
    }
  }
}
