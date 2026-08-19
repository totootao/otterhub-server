// functions/utils/tg-pool.ts
// 多 Bot/多频道池化：分摊 Telegram API 流控（同 bot 同 chat 约 1 msg/s）
//
// 配置格式（环境变量 TG_BOT_POOLS，JSON 数组，可选）：
//   [{"token":"111:AAA","chatId":"-100xxx"},{"token":"222:BBB","chatId":"-100yyy"}]
// 也支持简化写法（用 | 分隔，顺序 token|chatId，多项用逗号或换行）：
//   TG_BOT_POOLS=111:AAA|-100xxx,222:BBB|-100yyy
// 未配置时回退为单槽位池 [{token: TG_BOT_TOKEN, chatId: TG_CHAT_ID}]，行为与旧版完全一致。
//
// 关键约束：Telegram 的 file_id 与 bot 绑定——哪个 bot 上传的文件，
// 只能用该 bot 的 token 调 getFile / 下载。因此：
// - 上传时把所用槽位写入 FileMetadata.tgSlot（单文件）/ Chunk.slot（分片）
// - 下载时按记录的槽位取 token；旧数据无记录 → 槽位 0（主 bot）

import { getTextFromCache, putTextToCache } from "@utils/cache";
import { getTgFilePath } from "@utils/db-adapter/tg-tools";

export type TgBotSlot = {
  token: string;
  chatId: string;
};

const PATH_CACHE_NAMESPACE = "tgpath";
const PATH_CACHE_TTL = 3300; // Telegram file_path 有效期 1 小时，缓存 55 分钟

/** 解析 TG_BOT_POOLS 配置，回退单槽位（TG_BOT_TOKEN/TG_CHAT_ID） */
export function getTgPool(env: any): TgBotSlot[] {
  const raw = env?.TG_BOT_POOLS;
  const pool: TgBotSlot[] = [];

  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const slot = normalizeSlot(item);
          if (slot) pool.push(slot);
        }
      }
    } catch {
      // 简化格式：token|chatId,token|chatId（逗号或换行分隔）
      for (const part of raw.split(/[,\n]/)) {
        const seg = part.trim();
        if (!seg) continue;
        const [token, chatId] = seg.split("|").map((s) => s?.trim());
        if (token && chatId) pool.push({ token, chatId });
      }
    }
  }

  if (pool.length === 0) {
    const token = env?.TG_BOT_TOKEN;
    const chatId = env?.TG_CHAT_ID;
    if (token && chatId) {
      pool.push({ token: String(token), chatId: String(chatId) });
    }
  }

  return pool;
}

function normalizeSlot(item: any): TgBotSlot | null {
  if (!item || typeof item !== "object") return null;
  const token = typeof item.token === "string" ? item.token.trim() : "";
  const chatId =
    typeof item.chatId === "string" || typeof item.chatId === "number"
      ? String(item.chatId).trim()
      : "";
  if (!token || !chatId) return null;
  return { token, chatId };
}

/** 取指定槽位，越界回退槽位 0 */
export function getTgSlot(env: any, index?: number): TgBotSlot | null {
  const pool = getTgPool(env);
  if (!pool.length) return null;
  const idx = normalizeIndex(index, pool.length);
  return pool[idx];
}

function normalizeIndex(index: number | undefined, size: number): number {
  if (!Number.isInteger(index) || index! < 0) return 0;
  return index! % size;
}

/**
 * 跨 isolate 槽位分散策略：
 * - isolatePhase：每个 isolate 启动时随机相位，避免不同 isolate 的
 *   计数器从 0 开始同步增长（实测纯计数器在多 isolate 下仍会集体撞同一槽位）
 * - rrCounter：isolate 内自增，保证同一实例内同秒并发请求互不碰撞
 * 时钟分量让不同时间到达的请求天然轮转；残余的跨 isolate 偶发碰撞
 * 由 sendToTelegram 的 429 自动换槽兜底
 */
const isolatePhase = Math.floor(Math.random() * 1_000_000);
let rrCounter = 0;
function nextRR(): number {
  return isolatePhase + rrCounter++;
}

/**
 * 上传槽位选择（单文件/小文件路径）：
 * 秒级时间片 + 随机相位 + isolate 内计数。
 * 纯秒级取模在并发上传时会全部命中同一槽位（实测 3 并发上传即触发
 * Telegram 单聊天 1 msg/s 流控），混合后同 isolate 并发互不碰撞、
 * 跨 isolate 也随机错开。
 */
export function pickTgSlotIndex(poolSize: number): number {
  if (poolSize <= 1) return 0;
  return (Math.floor(Date.now() / 1000) + nextRR()) % poolSize;
}

/**
 * 分片上传槽位选择：
 * 分片序号 + 随机相位 + isolate 内计数。
 * 纯序号取模时，多个文件并行上传各自的 chunk0 会全部命中槽位 0，
 * 混合后不同文件的相同序号分片也互不碰撞。
 */
export function pickChunkSlotIndex(
  poolSize: number,
  chunkIndex: number
): number {
  if (poolSize <= 1) return 0;
  return (chunkIndex + nextRR()) % poolSize;
}

/**
 * 解析 Telegram 文件路径（getFile），带缓存并支持跨槽位探测。
 *
 * - 优先尝试 preferSlot（文件元数据记录的上传槽位）
 * - preferSlot 失败（旧数据 / 记录缺失）时按顺序遍历其余槽位
 * - 成功结果缓存为 "slot|filePath"（旧格式纯 filePath 视为槽位 0）
 *
 * @returns { filePath, slot } 或 null
 */
export async function resolveTgFilePath(
  env: any,
  fileId: string,
  opts: { preferSlot?: number; forceRefresh?: boolean } = {}
): Promise<{ filePath: string; slot: number } | null> {
  const pool = getTgPool(env);
  if (!pool.length) return null;

  const preferSlot = normalizeIndex(opts.preferSlot, pool.length);

  // 1. 缓存命中（forceRefresh 时跳过）
  if (!opts.forceRefresh) {
    try {
      const cached = await getTextFromCache(PATH_CACHE_NAMESPACE, fileId);
      if (cached) {
        const parsed = parsePathCache(cached, pool.length);
        if (parsed) return parsed;
      }
    } catch (error) {
      console.warn(`[tg-pool] Cache read failed for ${fileId}`, error);
    }
  }

  // 2. 依次尝试槽位：preferSlot 优先，其余按顺序
  const order = [
    preferSlot,
    ...pool.map((_, i) => i).filter((i) => i !== preferSlot),
  ];
  for (const slotIndex of order) {
    const filePath = await getTgFilePath(
      fileId,
      pool[slotIndex].token,
      (info) => {
        // 诊断：getFile 失败全量记录（429 流控 / wrong file_id / 网络错误均可区分）
        void recordTgError(env, {
          op: "getFile",
          slot: slotIndex,
          code: info.code,
          desc: info.desc.slice(0, 120),
          fid: fileId.slice(0, 20),
        });
      }
    );
    if (filePath) {
      try {
        await putTextToCache(
          PATH_CACHE_NAMESPACE,
          fileId,
          `${slotIndex}|${filePath}`,
          PATH_CACHE_TTL
        );
      } catch (error) {
        console.warn(`[tg-pool] Cache write failed for ${fileId}`, error);
      }
      return { filePath, slot: slotIndex };
    }
  }

  return null;
}

/** 解析缓存值："slot|filePath" 新格式 / 纯 filePath 旧格式（槽位 0） */
function parsePathCache(
  cached: string,
  poolSize: number
): { filePath: string; slot: number } | null {
  const sep = cached.indexOf("|");
  if (sep > 0) {
    const slot = Number(cached.slice(0, sep));
    if (Number.isInteger(slot) && slot >= 0 && slot < poolSize) {
      return { slot, filePath: cached.slice(sep + 1) };
    }
    return null; // 槽位越界（池规模缩小过）：视为未命中，重新探测
  }
  // 旧格式缓存：历史文件必属主 bot（槽位 0）
  return { slot: 0, filePath: cached };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==========================================
// TG API 错误环形日志（诊断流控用）
// 写入 KV（自建 RemoteKV 无配额压力），保留最近 40 条，
// 通过 GET /telegram/pool/errors 读取，POST /telegram/pool/errors/clear 清空。
// 注：并发写入存在读改写竞态，极端时丢个别条目，诊断场景可接受。
// ==========================================
const ERRLOG_KEY = "tgpool:errlog";
const ERRLOG_MAX = 40;

export async function recordTgError(
  env: any,
  entry: Record<string, any>
): Promise<void> {
  try {
    const kv = env?.oh_file_url;
    if (!kv) return;
    const cur = await kv.get(ERRLOG_KEY);
    const arr: any[] = cur ? JSON.parse(cur) : [];
    arr.unshift({ t: Date.now(), ...entry });
    await kv.put(ERRLOG_KEY, JSON.stringify(arr.slice(0, ERRLOG_MAX)));
  } catch {
    // 诊断日志失败不影响主流程
  }
}

export async function getTgErrorLog(env: any): Promise<any[]> {
  try {
    const cur = await env?.oh_file_url?.get(ERRLOG_KEY);
    return cur ? JSON.parse(cur) : [];
  } catch {
    return [];
  }
}

export async function clearTgErrorLog(env: any): Promise<void> {
  try {
    await env?.oh_file_url?.delete(ERRLOG_KEY);
  } catch {
    // ignore
  }
}
