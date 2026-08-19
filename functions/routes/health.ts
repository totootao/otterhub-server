import { Hono } from "hono";
import type { Env } from "../types/hono";
import { ok } from "@utils/response";
import { getTgPool } from "@utils/tg-pool";

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get("/", (c) => {
  const hasKV = !!c.env.oh_file_url;
  const hasR2 = !!c.env.oh_file_r2;
  const tgPoolSize = getTgPool(c.env).length;
  const hasTg = tgPoolSize > 0;

  return ok(c, {
    status: "ok",
    timestamp: new Date().toISOString(),
    checks: {
      kv: hasKV,
      r2: hasR2,
      tg: hasTg,
    },
    tgPoolSize, // 多 Bot 池规模（>1 表示流控分摊已启用）
  });
});
