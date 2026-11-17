import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config.js';
import { assertInsideRoot } from '../security.js';
import { getIndex } from '../library/organizer.js';
import type { ToolResult } from './index.js';

const KIND_EXT: Record<string, string[]> = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'],
  quote: ['.xlsx', '.xls', '.csv', '.xlsm'],
  cert: ['.pdf', '.txt', '.md', '.png', '.jpg'],
  case: ['.json', '.md', '.csv'],
};

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > 6 || out.length > 4000) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['node_modules', '.git', '.workbuddy'].includes(e.name)) walk(abs, depth + 1, out);
    } else if (e.isFile()) {
      out.push(abs);
    }
  }
}

/** 只读白名单目录检索；路径 realpath 校验，禁止目录穿越 */
export function fileSearch(args: { sku?: string; kind?: string; keyword?: string }): ToolResult {
  if (!fs.existsSync(cfg.kbRoot)) {
    return { ok: false, data: { files: [], hint: `KB_ROOT 不存在：${cfg.kbRoot}，请把库存表 / 报价文档放进 data/客服资料库，再运行 npm run organize:library` } };
  }
  const rootReal = assertInsideRoot(cfg.kbRoot);
  const all: string[] = [];
  walk(rootReal, 0, all);
  const needle = String(args.keyword ?? args.sku ?? '').trim().toLowerCase();
  const kind = String(args.kind ?? '').toLowerCase();
  const exts = KIND_EXT[kind];

  const matched = all
    .filter((f) => {
      const rel = path.relative(rootReal, f).split(path.sep).join('/');
      if (needle && !rel.toLowerCase().includes(needle)) return false;
      if (exts && !exts.includes(path.extname(f).toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, 5);

  const files = matched.map((f) => ({
    path: path.relative(rootReal, f).split(path.sep).join('/'),
    name: path.basename(f),
    mtime: new Date(fs.statSync(f).mtimeMs).toISOString(),
    size: fs.statSync(f).size,
  }));

  // 图片往往不是独立文件，而是嵌在报价表里（库存表里往往有大量单元格图片）。
  // 按型号命中索引时，把「这张图在哪张表的第几行」一起返回，避免 AI 编造图片文件名。
  const index = getIndex();
  let embeddedHint = '';
  if (index && needle) {
    const nk = needle.replace(/[\s_\-#]/g, '');
    const seen = new Set<string>();
    for (const q of index.报价) {
      const model = q.型号.toLowerCase().replace(/[\s_\-#]/g, '');
      if (!model.includes(nk) && !q.关键词.includes(needle)) continue;
      if (seen.has(q.文件)) continue;
      seen.add(q.文件);
      const abs = path.join(rootReal, q.文件);
      if (!fs.existsSync(abs) || matched.includes(abs)) continue;
      const info = index.文件.find((x) => x.路径 === q.文件);
      files.push({
        path: q.文件,
        name: path.basename(q.文件),
        mtime: new Date(fs.statSync(abs).mtimeMs).toISOString(),
        size: fs.statSync(abs).size,
      });
      if (info?.内嵌图片) {
        embeddedHint = `型号 ${q.型号} 在「${q.工作表}」第 ${q.行号} 行；这张报价表里嵌有 ${info.内嵌图片} 张产品图，请人工打开原表另存后再发，不要编造图片文件名。`;
      }
      if (seen.size >= 3) break;
    }
  }

  return {
    ok: files.length > 0,
    data: {
      files: files.slice(0, 8),
      root: rootReal,
      ...(embeddedHint ? { hint: embeddedHint } : {}),
      ...(files.length ? {} : { hint: '未找到匹配资料，请人工补充，禁止虚构文件名' }),
    },
  };
}
