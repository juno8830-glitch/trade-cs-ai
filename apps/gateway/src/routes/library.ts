import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { cfg } from '../config.js';
import { getIndex, libraryStatus, organizeLibrary, searchLibrary } from '../library/organizer.js';

/** 资料库整理 / 状态 / 检索，界面上的「一键整理资料」按钮就调这里 */
export default async function libraryRoute(app: FastifyInstance): Promise<void> {
  /** 只是看状态，不读大文件，界面每次打开都会调 */
  app.get('/v1/library/status', async () => libraryStatus());

  /** 一键整理：只读用户原始资料，只写 data/ 下的索引与清单 */
  app.post('/v1/library/organize', async (req) => {
    const body = (req.body ?? {}) as { force?: boolean };
    const r = organizeLibrary({ force: !!body.force });
    return { ...r, 状态: libraryStatus() };
  });

  /** 关键词检索（调试 / WorkBuddy 用） */
  app.get('/v1/library/search', async (req) => {
    const q = (req.query ?? {}) as { keyword?: string; limit?: string };
    return searchLibrary(String(q.keyword ?? ''), Math.min(Math.max(Number(q.limit) || 8, 1), 20));
  });

  /** 给浏览器版看的中文清单；桌面版直接用系统默认程序打开 md 文件 */
  app.get('/docs/library', async (_req, reply) => {
    const file = path.join(cfg.root, 'data', '资料清单.md');
    const body = fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8')
      : '还没有生成资料清单。请先在界面上点「🗂 一键整理资料」。';
    const esc = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return reply.type('text/html; charset=utf-8').send(
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>我的资料库清单</title>' +
      '<style>body{font:15px/1.8 "Microsoft YaHei",sans-serif;max-width:1000px;margin:24px auto;padding:0 20px;color:#1f2937}' +
      'pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;padding:18px}' +
      'a{color:#2563eb}</style></head><body>' +
      '<h2>我的资料库清单</h2><p>这份清单由程序自动生成，<b>你的原始文件一个都没改动</b>。' +
      '价格、货期请打开来源文件对应行人工核对。<a href="/app/">← 返回操作界面</a></p>' +
      `<pre>${esc}</pre></body></html>`,
    );
  });

  /** 给 WorkBuddy / 体检用的极简「关联上了吗」判断 */
  app.get('/v1/library/ready', async () => {
    const idx = getIndex();
    return {
      ready: !!idx,
      models: idx?.统计.型号数 ?? 0,
      rows: idx?.统计.报价行数 ?? 0,
      generated_at: idx?.生成时间 ?? null,
    };
  });
}
