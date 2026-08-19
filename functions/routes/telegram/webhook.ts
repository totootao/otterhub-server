import { Hono, Context } from "hono";
import { FileMetadata, MAX_CHUNK_SIZE } from "@shared/types";
import type { Env } from "../../types/hono";
import { authMiddleware } from "../../middleware/auth";
import { buildKeyId } from "@utils/file";
import { fail, ok } from "@utils/response";
import {
  getTgPool,
  getTgSlot,
  getTgErrorLog,
  clearTgErrorLog,
} from "@utils/tg-pool";
import {
  buildTgApiUrl,
  buildTelegramDirectLink,
  getTelegramFileFromMessage,
  sendTelegramUploadNotice,
} from "@utils/db-adapter/tg-tools";
import { tgFetch } from "@utils/tg-proxy";

export const telegramWebhookRoutes = new Hono<{ Bindings: Env }>();

telegramWebhookRoutes.use("/webhook/setup", authMiddleware);
telegramWebhookRoutes.use("/webhook/info", authMiddleware);
telegramWebhookRoutes.use("/webhook/:slot/setup", authMiddleware);
telegramWebhookRoutes.use("/webhook/:slot/info", authMiddleware);
telegramWebhookRoutes.use("/pool/errors", authMiddleware);
telegramWebhookRoutes.use("/pool/errors/clear", authMiddleware);

/**
 * TG API 错误环形日志（诊断流控）：
 * sendToTelegram / getFile 的非 200 响应全量记录，保留最近 40 条。
 */
telegramWebhookRoutes.get("/pool/errors", async (c) => {
  const log = await getTgErrorLog(c.env);
  return ok(c, { count: log.length, log });
});

telegramWebhookRoutes.post("/pool/errors/clear", async (c) => {
  await clearTgErrorLog(c.env);
  return ok(c, true);
});

/**
 * Telegram webhook 健康检查入口。
 */
telegramWebhookRoutes.get("/webhook", async (c) => {
  return ok(c, {
    ready: true,
    endpoint: new URL(c.req.url).pathname,
    poolSize: getTgPool(c.env).length,
  });
});

/**
 * 接收 Telegram message/channel_post 并将媒体 file_id 注册到 OtterHub KV。
 *
 * 多 Bot 池说明：file_id 与 bot 绑定。每个池内 bot 的 webhook 指向
 * /telegram/webhook/<slot>（槽位号），据此把 tgSlot 写入文件元数据，
 * 下载时用对应 bot 的 token。旧地址 /telegram/webhook 视为槽位 0。
 */
const handleWebhookUpdate = async (
  c: Context<{ Bindings: Env }>,
  rawSlot?: string
) => {
  const pool = getTgPool(c.env);
  if (!pool.length) {
    return fail(c, "TG bot pool not configured", 500);
  }

  const parsedSlot = Number(rawSlot);
  const slot =
    Number.isInteger(parsedSlot) && parsedSlot >= 0 && parsedSlot < pool.length
      ? parsedSlot
      : 0;
  const slotInfo = getTgSlot(c.env, slot)!;

  const expectedSecret = c.env.TG_WEBHOOK_SECRET;
  if (expectedSecret) {
    const headerSecret = c.req.header("X-Telegram-Bot-Api-Secret-Token") || "";
    if (headerSecret !== expectedSecret) {
      return fail(c, "Invalid webhook secret", 401);
    }
  }

  const update = await c.req.json().catch(() => null);
  if (!update) {
    return fail(c, "Invalid JSON body", 400);
  }

  const message = update?.message || update?.channel_post;
  if (!message) {
    return ok(c, { ignored: "no-message" });
  }

  const media = getTelegramFileFromMessage(message);
  if (!media) {
    return ok(c, { ignored: "message-without-file" });
  }

  const key = buildKeyId(media.fileType, media.fileId, media.ext);
  const origin = new URL(c.req.url).origin;
  const directLink = buildTelegramDirectLink(origin, key);
  const chatId = message?.chat?.id;
  const shouldNotify = Boolean(chatId);

  if (media.fileSize > MAX_CHUNK_SIZE) {
    // 文件超过 20MB，无法通过 Telegram 频道导入
    // 避免干扰，这里不做消息提醒
    return ok(c, {
      ignored: "file-too-large",
      key,
      maxSize: MAX_CHUNK_SIZE,
    });
  }

  const existing = await c.env.oh_file_url.getWithMetadata<FileMetadata>(key);
  if (existing.metadata) {
    if (shouldNotify) {
      const noticeResult = await sendTelegramUploadNotice(slotInfo.token, {
        chatId,
        replyToMessageId: message.message_id,
        directLink,
        fileId: media.fileId,
        messageId: media.messageId || message.message_id,
        fileName: media.fileName,
        fileSize: media.fileSize,
        text: `[OtterHub]\n文件已存在：${directLink}`,
      });

      if (!noticeResult.ok && !noticeResult.skipped) {
        console.warn(
          "[TelegramWebhook] Duplicate notice failed:",
          noticeResult.data?.description ||
            noticeResult.error ||
            "unknown error"
        );
      }
    }

    return ok(c, {
      key,
      url: directLink,
      existed: true,
    });
  }

  const metadata: FileMetadata = {
    fileName: media.fileName,
    fileSize: media.fileSize,
    uploadedAt: Date.now(),
    liked: false,
    thumbUrl: media.previewFileId
      ? `/file/${media.previewFileId}/thumb`
      : undefined,
    tgSlot: slot, // file_id 属于该槽位的 bot，下载须用其 token
  };

  await c.env.oh_file_url.put(key, "", { metadata });

  if (shouldNotify) {
    const noticeResult = await sendTelegramUploadNotice(slotInfo.token, {
      chatId,
      replyToMessageId: message.message_id,
      directLink,
      fileId: media.fileId,
      messageId: media.messageId || message.message_id,
      fileName: media.fileName,
      fileSize: media.fileSize,
    });

    if (!noticeResult.ok && !noticeResult.skipped) {
      console.warn(
        "[TelegramWebhook] Upload notice failed:",
        noticeResult.data?.description || noticeResult.error || "unknown error"
      );
    }
  }

  return ok(c, {
    key,
    url: directLink,
  });
};

/** 旧地址（兼容已设置的 webhook）：槽位 0 */
telegramWebhookRoutes.post("/webhook", (c) => handleWebhookUpdate(c));

/** 多 Bot 池地址：/telegram/webhook/<slot> */
telegramWebhookRoutes.post("/webhook/:slot{\\d+}", (c) =>
  handleWebhookUpdate(c, c.req.param("slot"))
);

/**
 * 查询指定槽位的 Telegram webhook 绑定状态（?slot=N，默认 0）。
 */
const handleWebhookInfo = async (
  c: Context<{ Bindings: Env }>,
  rawSlot?: string
) => {
  const pool = getTgPool(c.env);
  if (!pool.length) {
    return ok(c, {
      configured: false,
      reason: "missing-token",
    });
  }

  const parsedSlot = Number(rawSlot);
  const slot =
    Number.isInteger(parsedSlot) && parsedSlot >= 0 && parsedSlot < pool.length
      ? parsedSlot
      : 0;
  const slotInfo = getTgSlot(c.env, slot)!;

  const result = await callTelegramApi(slotInfo.token, "getWebhookInfo");
  if (!result.ok) {
    return fail(
      c,
      result.description || "Failed to get Telegram webhook info",
      502
    );
  }

  return ok(c, {
    slot,
    poolSize: pool.length,
    configured: Boolean(result.result?.url),
    url: result.result?.url || "",
    pendingUpdateCount: result.result?.pending_update_count ?? 0,
    lastErrorMessage: result.result?.last_error_message,
  });
};

telegramWebhookRoutes.get("/webhook/info", (c) => handleWebhookInfo(c));
telegramWebhookRoutes.get("/webhook/:slot/info", (c) =>
  handleWebhookInfo(c, c.req.param("slot"))
);

/**
 * 使用后端环境变量配置指定槽位的 Telegram webhook（?slot=N，默认 0）。
 * 多 Bot 池：每个 bot 各自调用一次（slot=0,1,2...），webhook 地址带槽位号。
 */
const handleWebhookSetup = async (
  c: Context<{ Bindings: Env }>,
  rawSlot?: string
) => {
  const pool = getTgPool(c.env);
  if (!pool.length) {
    return fail(c, "TG bot pool not configured", 500);
  }
  if (!c.env.TG_WEBHOOK_SECRET) {
    return fail(c, "TG_WEBHOOK_SECRET is not configured", 400);
  }

  const parsedSlot = Number(rawSlot);
  const slot =
    Number.isInteger(parsedSlot) && parsedSlot >= 0 && parsedSlot < pool.length
      ? parsedSlot
      : 0;
  const slotInfo = getTgSlot(c.env, slot)!;

  const webhookUrl = buildTelegramWebhookUrl(new URL(c.req.url).origin, slot);
  const result = await callTelegramApi(slotInfo.token, "setWebhook", {
    url: webhookUrl,
    secret_token: c.env.TG_WEBHOOK_SECRET,
    allowed_updates: ["message", "channel_post"],
  });

  if (!result.ok) {
    return fail(c, result.description || "Failed to set Telegram webhook", 502);
  }

  return ok(c, {
    slot,
    poolSize: pool.length,
    webhookUrl,
    telegramResult: result,
  });
};

telegramWebhookRoutes.post("/webhook/setup", (c) => handleWebhookSetup(c));
telegramWebhookRoutes.post("/webhook/:slot/setup", (c) =>
  handleWebhookSetup(c, c.req.param("slot"))
);

/**
 * 调用 Telegram Bot API 并返回解析后的 JSON。
 */
async function callTelegramApi(
  botToken: string,
  method: string,
  payload?: Record<string, unknown>
): Promise<any> {
  const response = await tgFetch(buildTgApiUrl(botToken, method), {
    method: payload ? "POST" : "GET",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return {
    ...data,
    ok: response.ok && data?.ok === true,
  };
}

/**
 * 生成当前部署可访问的 Telegram webhook URL（槽位 0 用旧地址，保持兼容）。
 */
function buildTelegramWebhookUrl(origin: string, slot: number): string {
  const base = origin.replace(/\/+$/, "");
  return slot === 0
    ? `${base}/telegram/webhook`
    : `${base}/telegram/webhook/${slot}`;
}
