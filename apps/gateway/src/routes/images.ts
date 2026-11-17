import type { FastifyInstance } from 'fastify';
import {
  getBuildState,
  getOriginalImage,
  imageStatus,
  listPreview,
  matchImage,
  startImageBuild,
} from '../library/imageIndex.js';

/**
 * 图片能力的 HTTP 出口。
 * 全部走 /v1/ 前缀（Electron 的 bridge.api 白名单 + 浏览器版 Bearer 口令都认），
 * 缩略图以 dataURL 内嵌返回，避免 <img> 请求带不了鉴权头。
 */

const MAX_BYTES = 24 * 1024 * 1024;

function decodeImageArg(s: unknown): Buffer | null {
  const raw = String(s ?? '').trim();
  if (!raw) return null;
  const m = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(raw);
  const b64 = m ? m[1].replace(/\s/g, '') : /^[a-z0-9+/=]+$/i.test(raw) && raw.length > 100 ? raw : '';
  if (!b64) return null;
  const buf = Buffer.from(b64, 'base64');
  return buf.length > 64 && buf.length <= MAX_BYTES ? buf : null;
}

export default async function imagesRoute(app: FastifyInstance): Promise<void> {
  // 索引状态 + 后台构建进度（前端 hover 浮层与轮询都用这个）
  app.get('/v1/images/status', async () => imageStatus());

  // 资料库图片预览：默认给 24 张有型号的缩略图
  app.get('/v1/images/preview', async (req) => {
    const q = (req.query ?? {}) as { offset?: string; limit?: string };
    const offset = Math.max(0, Number(q.offset) || 0);
    const limit = Math.min(60, Math.max(1, Number(q.limit) || 24));
    return listPreview(offset, limit);
  });

  // 客户图片 → 最像的几张 → 型号 / 出厂价 / 来源行号
  app.post('/v1/images/match', async (req) => {
    const body = (req.body ?? {}) as { image?: string; limit?: number };
    const buf = decodeImageArg(body.image);
    if (!buf) {
      return {
        ok: false,
        候选: [],
        索引图片数: 0,
        索引时间: '',
        耗时毫秒: 0,
        hint: '没收到能读的图片。请选一张 png / jpg / webp 的产品图，或把图片压缩后再试。',
      };
    }
    return matchImage(buf, Math.max(1, Math.min(10, Number(body.limit) || 5)));
  });

  // 按 id 取「可以发给客户的原图」：只读原始资料，不写不改不移动任何用户文件
  app.get('/v1/images/original', async (req) => {
    const q = (req.query ?? {}) as { id?: string };
    if (!q.id) {
      return { ok: false, hint: '没给图片 id，请先在图片匹配结果里选一张。', 图片: '', 文件名: '' };
    }
    return getOriginalImage(q.id);
  });

  // 后台重建索引（首次可能几十秒）；不阻塞请求，前端轮询 /v1/images/status
  app.post('/v1/images/rebuild', async (req) => {
    const force = Boolean((req.body as { force?: boolean } | undefined)?.force);
    const started = startImageBuild(force);
    return {
      ok: started,
      提示: started
        ? '已在后台开始重建图片索引，只读取原文件、只在 data/ 下生成指纹和缩略图，不会改动你的原始资料。'
        : '图片索引正在构建中，请稍等并查看进度。',
      状态: getBuildState(),
    };
  });
}
