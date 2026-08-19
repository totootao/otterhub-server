import { DBAdapter } from ".";
import { Chunk, chunkPrefix, FileMetadata, trashPrefix } from "@shared/types";
import { TRASH_EXPIRATION_TTL } from "@shared/types";
import { extractKeyFromTrash, isUploadedChunk } from "./shared-utils";
import { getUniqueFileId } from "../file";
/**
 * 存储适配器基类
 * 提供通用的分片文件处理逻辑
 */
export abstract class BaseAdapter implements DBAdapter {
  protected env: any;
  protected kvName: string;

  constructor(env: any, kvName: string) {
    this.env = env;
    this.kvName = kvName;
  }

  // 子类必须实现的方法
  abstract uploadFile(
    file: File | Blob | Uint8Array,
    metadata: FileMetadata,
    waitUntil?: (p: Promise<any>) => void
  ): Promise<{ key: string }>;

  abstract uploadStream(
    stream: ReadableStream,
    metadata: FileMetadata,
    waitUntil?: (p: Promise<any>) => void,
    mimeType?: string
  ): Promise<{ key: string }>;

  abstract get(key: string, req?: Request): Promise<Response>;

  abstract delete(key: string): Promise<{ isDeleted: boolean }>;

  /**
   * 将文件移入回收站
   */
  async moveToTrash(key: string): Promise<void> {
    const kv = this.env[this.kvName];
    const item = await this.getFileMetadataWithValue(key);
    if (!item) {
      throw new Error("File not found");
    }

    const trashKey = `${trashPrefix}${key}`;
    await kv.put(trashKey, item.value || "", {
      metadata: item.metadata,
      expirationTtl: TRASH_EXPIRATION_TTL,
    });

    // 从 KV 中删除原文件记录
    await kv.delete(key);
  }

  /**
   * 从回收站还原文件
   */
  async restoreFromTrash(trashKey: string): Promise<void> {
    const kv = this.env[this.kvName];
    const { value, metadata } = await kv.getWithMetadata(trashKey);
    if (!metadata) {
      throw new Error("File not found in trash");
    }

    const originalKey = extractKeyFromTrash(trashKey);

    await kv.put(originalKey, value || "", { metadata });
    await kv.delete(trashKey);
  }

  /**
   * 子类必须实现的抽象方法：上传分片到目标存储
   * @param chunkFile 要上传的分片文件
   * @param parentKey 父文件的 key
   * @param chunkIndex 分片索引
   * @returns 上传后的分片 ID
   */
  protected abstract uploadToTarget(
    chunkFile: File | Blob | Uint8Array,
    parentKey: string,
    chunkIndex: number,
    fileName?: string
  ): Promise<string | { chunkId: string; thumbUrl?: string; slot?: number }>;

  /**
   * 子类可选实现的方法：生成分片 ID
   * 默认实现：使用父 key 的一部分生成简短 ID
   * @param parentKey 父文件的 key
   * @param chunkIndex 分片索引
   * @returns 分片 ID
   */
  protected getTempChunkId(parentKey: string, chunkIndex: number): string {
    const shortFileId =
      parentKey.split("_")[1]?.slice(0, 16) || getUniqueFileId();
    return `${chunkPrefix}${shortFileId}_${chunkIndex}`;
  }

  /**
   * 上传单个分片（通用实现，直传版）
   *
   * 历史实现（consumeChunk 模板方法）会先把分片暂存临时 KV 再读回上传：
   * 自建 KV（RemoteKV）场景下每个 20MB 分片都要 base64 编码(~27MB) →
   * HTTP PUT → HTTP GET → base64 解码，纯 CPU 编解码直接触发
   * "Worker exceeded resource limits"（1102）。
   * 现在分片 body 已在内存（formData 解析结果），直传目标存储，无 KV 往返。
   *
   * 流程：
   * 1. 获取当前 metadata
   * 2. 检查分片是否已上传（幂等）
   * 3. 直接调用子类的 uploadToTarget 上传到目标存储（无临时 KV）
   * 4. 更新 KV metadata 记录分片 ID
   *
   * 注意：同步 await 完成后再返回，保证 200 响应时分片已真正落库，
   * 调用方（中转网关/前端）可立即感知失败并重试，避免"假成功"的残缺文件。
   */
  async uploadChunk(
    key: string,
    chunkIndex: number,
    chunkFile: File | Blob,
    waitUntil?: (promise: Promise<any>) => void
  ): Promise<{ chunkIndex: number }> {
    // 1. 获取当前 metadata
    const item = await this.getFileMetadataWithValue(key);
    if (!item) {
      throw new Error("File not found");
    }

    const { metadata } = item;
    if (!metadata?.chunkInfo) {
      throw new Error("Not a chunked file");
    }

    // 2. 检查分片是否已上传（幂等，重复上传直接跳过）
    if (isUploadedChunk(metadata, chunkIndex)) {
      return { chunkIndex };
    }

    // 3. 直接上传到目标存储（不再暂存临时 KV）
    const result = await this.uploadToTarget(
      chunkFile,
      key,
      chunkIndex,
      metadata.fileName
    );

    let chunkId: string;
    let thumbUrl: string | undefined;
    let chunkSlot: number | undefined;
    if (typeof result === "string") {
      chunkId = result;
    } else {
      chunkId = result.chunkId;
      thumbUrl = result.thumbUrl;
      chunkSlot = result.slot;
    }

    console.log(`[uploadChunk] Uploaded chunk ${chunkIndex}: ${chunkId}`);

    // 4. 更新 KV metadata（记录分片 ID 与进度）
    await this.updateChunkInfo(
      key,
      chunkIndex,
      chunkId,
      chunkFile.size,
      thumbUrl,
      chunkSlot
    );

    return { chunkIndex };
  }

  /**
   * 获取上传进度（通用实现）
   */
  async getProgress(key: string): Promise<{
    uploaded: number;
    total: number;
    complete: boolean;
  } | null> {
    const item = await this.getFileMetadataWithValue(key);
    if (!item) {
      return null;
    }
    const { metadata } = item;

    if (!metadata?.chunkInfo) {
      return null;
    }

    const { chunkInfo } = metadata;
    const uploaded = chunkInfo.uploadedIndices?.length;
    const total = chunkInfo.total;
    const complete = uploaded === total;

    return { uploaded, total, complete };
  }

  /**
   * 获取文件元数据（公开方法，用于权限检查）
   */
  public async getFileMetadataWithValue(key: string): Promise<{
    metadata: FileMetadata;
    value: string | null;
  } | null> {
    try {
      const item = await this.env[this.kvName].getWithMetadata(key);
      return { metadata: item.metadata, value: item.value };
    } catch (error) {
      console.error(`[getMetadata] Error for key ${key}:`, error);
      return null;
    }
  }

  /**
   * 更新分片信息（使用重试机制避免并发冲突）
   */
  protected async updateChunkInfo(
    key: string,
    chunkIndex: number,
    chunkId: string,
    chunkSize: number,
    thumbUrl?: string,
    chunkSlot?: number
  ): Promise<void> {
    const kv = this.env[this.kvName];
    const maxRetries = 3;

    for (let i = 0; i < maxRetries; i++) {
      try {
        // 1. 获取最新状态
        const item = await this.getFileMetadataWithValue(key);
        if (!item) {
          throw new Error(`[updateChunkInfo] File not found: ${key}`);
        }

        const { metadata, value } = item;
        if (!metadata?.chunkInfo) {
          throw new Error(
            `[updateChunkInfo] No metadata/chunkInfo for key: ${key}`
          );
        }

        const chunks: Chunk[] = value ? JSON.parse(value) : [];

        // 2. 检查是否已上传
        if (metadata.chunkInfo.uploadedIndices?.includes(chunkIndex)) {
          console.log(
            `[updateChunkInfo] Chunk ${chunkIndex} already uploaded, skipping`
          );
          return;
        }

        // 3. 更新 uploadedIndices
        if (!metadata.chunkInfo.uploadedIndices) {
          metadata.chunkInfo.uploadedIndices = [];
        }
        metadata.chunkInfo.uploadedIndices.push(chunkIndex);

        // 4. 更新 chunks 数组（存储在 value 中）
        chunks.push({
          idx: chunkIndex,
          file_id: chunkId,
          size: chunkSize,
          slot: chunkSlot, // TG 多 Bot 池槽位（file_id 与 bot 绑定，下载须用对应 bot）
        });

        // 如果有缩略图且元数据中没有，则更新
        if (thumbUrl && !metadata.thumbUrl) {
          metadata.thumbUrl = thumbUrl;
        }

        // 5. 写回 KV
        await kv.put(key, JSON.stringify(chunks), { metadata });

        console.log(
          `[updateChunkInfo] Updated chunk ${chunkIndex} (attempt ${i + 1})`
        );
        return;
      } catch (error) {
        console.error(`[updateChunkInfo] Attempt ${i + 1} failed:`, error);
        if (i === maxRetries - 1) {
          throw error;
        }
        // 指数退避
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, i) * 100)
        );
      }
    }
  }
}
