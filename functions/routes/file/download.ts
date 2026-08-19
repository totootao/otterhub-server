import { Hono } from "hono";

import { encodeContentDisposition } from "@utils/common";
import type { Env } from "../../types/hono";
import { getAuthorizedFileAccess } from "./access";

export const downloadRoutes = new Hono<{ Bindings: Env }>();

downloadRoutes.get("/:key/download", async (c) => {
  const key = c.req.param("key");
  const access = await getAuthorizedFileAccess(c.env, c.req.raw, key);

  if (access instanceof Response) {
    return access;
  }

  const { db, item, isPrivate } = access;
  const resp = await db.get(key, c.req.raw);
  const headers = new Headers(resp.headers);

  headers.set(
    "Content-Disposition",
    encodeContentDisposition(item.metadata.fileName, false),
  );
  headers.set("Cache-Control", "private, no-store, max-age=0");

  if (isPrivate) {
    headers.set("Vary", "Cookie, Authorization");
  }

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
});
