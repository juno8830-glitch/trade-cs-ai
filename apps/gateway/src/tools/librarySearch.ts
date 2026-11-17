import fs from 'node:fs';
import { cfg } from '../config.js';
import { getIndex, organizeLibrary, searchLibrary } from '../library/organizer.js';
import type { ToolResult } from './index.js';

/**
 * 资料库关键词检索：客户说「有没有皮壳」「Cover 系列多少钱」这类没有精确型号的问题时，
 * 用这个工具按型号 / 产品名 / 系列 / 规格 / 文件名找真实数据。
 */
export function librarySearch(args: { keyword?: string; limit?: number }): ToolResult {
  const keyword = String(args.keyword ?? '').trim();
  if (!fs.existsSync(cfg.kbRoot)) {
    return { ok: false, data: { hint: `资料文件夹不存在：${cfg.kbRoot}` } };
  }
  if (!getIndex()) organizeLibrary(); // 首次使用自动整理，不用用户手动点按钮
  const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20);
  const r = searchLibrary(keyword, limit) as { ok: boolean; data: Record<string, any> };
  return { ok: r.ok, data: r.data };
}
