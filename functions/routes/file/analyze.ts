import { Hono } from 'hono';
import { FileType } from '@shared/types';
import { authMiddleware } from '../../middleware/auth';
import { fail, ok } from '@utils/response';
import {
  isSupportedImage,
  AI_MODEL,
  AI_OUTPUT_PROMPT,
  extractImageDesc,
  normalizeDesc,
  AI_MAX_TOKENS,
} from '@utils/ai/image-analysis';
import type { Env } from '../../types/hono';

export const analyzeRoutes = new Hono<{ Bindings: Env }>();

analyzeRoutes.post(
  '/:key/analyze',
  authMiddleware,
  async (c) => {
    const key = c.req.param('key');

    // 验证是否为图片文件类型
    const colonIndex = key.indexOf(':');
    const fileType = colonIndex > 0 ? key.substring(0, colonIndex) : null;
    if (fileType !== FileType.Image || !isSupportedImage(null, key)) {
      return fail(c, 'Not a supported image file', 400);
    }

    if (!c.env.AI) {
      return fail(c, 'AI service not available', 503);
    }

    try {
      // 从 FormData 读取前端上传的压缩图片
      const formData = await c.req.formData();
      const imageBlob = formData.get('image');
      if (!(imageBlob instanceof Blob)) {
        return fail(c, 'Missing image in request body', 400);
      }

      const buffer = await imageBlob.arrayBuffer();

      const result = await c.env.AI.run(AI_MODEL, {
        image: Array.from(new Uint8Array(buffer)),
        prompt: AI_OUTPUT_PROMPT,
        max_tokens: AI_MAX_TOKENS,
      });

      const desc = normalizeDesc(extractImageDesc(result));
      if (!desc) {
        return fail(c, 'AI analysis returned empty result', 500);
      }

      return ok(c, { desc });
    } catch (e: any) {
      console.error('AI analysis error:', e);
      return fail(c, `AI analysis failed: ${e.message}`, 500);
    }
  }
);
