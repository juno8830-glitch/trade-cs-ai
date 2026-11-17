import fs from 'node:fs';
import path from 'node:path';
import { matchImage } from '../library/imageIndex.js';
import type { ToolResult } from './index.js';

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const MAX_BYTES = 24 * 1024 * 1024;

function decodeImageArg(s: string): Buffer | null {
  const raw = String(s ?? '').trim();
  if (!raw) return null;
  const m = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(raw);
  const b64 = m ? m[1].replace(/\s/g, '') : /^[a-z0-9+/=]+$/i.test(raw) && raw.length > 100 ? raw : '';
  if (!b64) return null;
  const buf = Buffer.from(b64, 'base64');
  return buf.length > 64 && buf.length <= MAX_BYTES ? buf : null;
}

/**
 * 按图查报价：客户发产品图时，用本地图片指纹库比对当前库存表 / 报价表里的产品图，
 * 返回候选型号 / 出厂价 / 货期 / 来源行号。只给候选，不替人做最终判断。
 */
export async function imageMatchQuote(args: {
  image?: string;
  image_path?: string;
  limit?: number;
}): Promise<ToolResult> {
  let buf: Buffer | null = null;
  if (args.image) {
    buf = decodeImageArg(args.image);
  } else if (args.image_path) {
    const p = String(args.image_path).trim();
    if (!IMAGE_EXT.test(p)) {
      return { ok: false, data: { hint: '不是常见图片格式，请用 png / jpg / webp。' } };
    }
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > MAX_BYTES) {
        return { ok: false, data: { hint: `图片不存在或超过 ${MAX_BYTES / 1024 / 1024}MB：${path.basename(p)}` } };
      }
      buf = fs.readFileSync(p);
    } catch (e) {
      return { ok: false, data: { hint: `读不到这张图片：${(e as Error).message}` } };
    }
  }
  if (!buf) {
    return {
      ok: false,
      data: { hint: '请给 image（base64 / dataURL）或 image_path（本机图片完整路径）。' },
    };
  }

  const r = await matchImage(buf, Math.max(1, Math.min(10, Number(args.limit) || 5)));
  // 缩略图是给界面看的，绝对不能塞进模型上下文（一张几千字符，几张就爆了）
  const 候选 = r.候选.map(({ 缩略图: _thumb, ...rest }) => rest);
  return {
    ok: r.ok,
    data: {
      ok: r.ok,
      候选,
      hint: r.hint,
      已裁白边: r.已裁白边,
      ...(r.重复图提示 ? { 重复图提示: r.重复图提示 } : {}),
      索引图片数: r.索引图片数,
      索引时间: r.索引时间,
      耗时毫秒: r.耗时毫秒,
      price_note: '这是出厂价 / 内部价，不是对外正式报价；发给客户前必须人工核对来源文件对应行。候选里价格为 null 或型号为空时，说明原表那一行还没填价格，回复稿一律写「待人工补充」，禁止从别行借价格；「名称」只是同行产品描述，不是型号。',
    },
  };
}
