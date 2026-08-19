import { Hono } from 'hono';
import { getFromCache, putToCache } from '@utils/cache';
import type { Env } from '../../types/hono';
import { fail } from '@utils/response';
import { getAuthorizedFileAccess } from './access';

export const rawRoutes = new Hono<{ Bindings: Env }>();

rawRoutes.get('/:key', async (c) => {
  const key = c.req.param('key');
  const access = await getAuthorizedFileAccess(c.env, c.req.raw, key);

  if (access instanceof Response) {
    return access;
  }

  const { db, isPrivate } = access;

  try {
    // Range 请求：明确不缓存
    if (c.req.header('Range')) {
      return await db.get(key, c.req.raw);
    }

    // Only check cache for public files
    if (!isPrivate) {
      const cached = await getFromCache(c.req.raw);
      if (cached) return cached;
    }

    const resp = await db.get(key, c.req.raw);

    // Only cache public files
    if (!isPrivate) {
      if (resp.status === 200) {
        c.executionCtx.waitUntil(putToCache(c.req.raw, resp.clone(), "file"));
      }
    } else {
      // Ensure private files are not cached by browser/proxies
      resp.headers.set("Cache-Control", "private, no-store, max-age=0");
    }

    return resp;
  } catch (error: any) {
    console.error('Fetch raw file error:', error);
    return fail(c, error.message);
  }
});
