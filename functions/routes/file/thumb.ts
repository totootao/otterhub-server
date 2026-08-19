import { Hono } from "hono";
import { buildTgFileUrl } from "@utils/db-adapter/tg-tools";
import { tgFetch } from "@utils/tg-proxy";
import { getTgPool, getTgSlot, resolveTgFilePath } from "@utils/tg-pool";
import type { Env } from "../../types/hono";
import { fail } from "@utils/response";

export const thumbRoutes = new Hono<{ Bindings: Env }>();

thumbRoutes.get("/:key/thumb", async (c) => {
  const thumbFileId = c.req.param("key");
  const pool = getTgPool(c.env);

  if (!pool.length) {
    return fail(c, "TG_BOT_TOKEN not configured", 500);
  }

  try {
    // thumb URL 只携带 file_id（无文件元数据），跨槽位依次探测：
    // 优先主 bot，失败则遍历其余槽位；结果按 fileId 缓存，后续请求直接命中
    const resolved = await resolveTgFilePath(c.env, thumbFileId);
    if (!resolved) {
      return fail(c, "Thumbnail not found", 404);
    }

    const slot = getTgSlot(c.env, resolved.slot);
    if (!slot) {
      return fail(c, "Thumbnail not found", 404);
    }

    const thumbUrl = buildTgFileUrl(slot.token, resolved.filePath);
    const response = await tgFetch(thumbUrl);

    if (!response.ok) {
      return fail(c, "Failed to fetch thumbnail", 502);
    }

    c.header(
      "Content-Type",
      response.headers.get("Content-Type") || "image/jpeg"
    );
    c.header("Cache-Control", "public, max-age=86400");

    return response.body ? c.body(response.body) : c.body(null);
  } catch (error: any) {
    console.error("Fetch thumbnail error:", error);
    return fail(c, error.message);
  }
});
