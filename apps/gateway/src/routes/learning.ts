import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { cleanDraftText } from '@trade-cs-ai/core';
import {
  deleteCase,
  deleteLearningRecord,
  getLearningRecord,
  insertLearningRecord,
  latestRecordBySession,
  learningStats,
  listLearningRecords,
  rateLearningRecord,
  upsertCase,
  type LearningRecord,
} from '../store/sqlite.js';
import { classifyIntent, intentInfo } from '../learning/intents.js';
import { loadScriptBook, rebuildScriptBook, saveAdvice, scriptFilePath, scriptReviewText } from '../learning/scripts.js';

/** 标记成功 → 真的写进案例库，AI 下次才能检索到；改判失败 → 撤出案例库 */
function syncCase(r: LearningRecord): void {
  const caseId = `case_${r.id}`;
  if (r.label !== 'success') {
    deleteCase(caseId);
    return;
  }
  // 只把「能发给客户的外文正文」写进案例库；中文翻译和注解是给客服看的，不是话术
  const script = cleanDraftText(r.draft_text ?? '');
  upsertCase({
    id: caseId,
    country: r.country || 'OTHER',
    product: r.product || '通用',
    stage: r.intent || r.stage || '',
    reusable_script: (script.trim() || r.note || r.customer_text || '成功回复').slice(0, 800),
    attachments: r.attachments.length ? r.attachments : ['（详见学习记录原文）'],
    updated_at: new Date().toISOString().slice(0, 10),
  });
}

/** WorkBuddy 连接自检：不猜、不重启，只读 WorkBuddy 自己写下的状态文件 */
function workbuddyStatus() {
  const dir = path.join(os.homedir(), '.workbuddy');
  const read = (f: string): string => {
    try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; }
  };
  const mcp = read('mcp.json');
  const approvals = read('mcp-approvals.json');
  const toolList = read('mcp-tool-list.json');

  const configured = (() => {
    try {
      const entry = JSON.parse(mcp || '{}').mcpServers?.['trade-cs-ai'];
      return Boolean(entry && entry.disabled !== true && Array.isArray(entry.args));
    } catch { return false; }
  })();
  const trusted = (() => {
    try { return Object.keys(JSON.parse(approvals || '{}')).length > 0; } catch { return false; }
  })();
  const loaded = toolList.includes('lookup_quote');
  const newToolsLoaded = toolList.includes('mark_outcome');

  let level: 'connected' | 'needs_restart' | 'not_configured';
  let message: string;
  let hint: string;
  if (!configured || !trusted) {
    level = 'not_configured';
    message = '还没接入 WorkBuddy';
    hint = '双击「一键启动.bat」时会自动配置；也可以选菜单 8 重新自动接入。';
  } else if (!loaded) {
    level = 'needs_restart';
    message = '配置好了，但 WorkBuddy 还没读到';
    hint = '完全退出 WorkBuddy 再重新打开一次即可，不用点「信任」。';
  } else if (!newToolsLoaded) {
    level = 'needs_restart';
    message = '已连上 WorkBuddy，但新增的学习工具还没加载';
    hint = '旧功能（查报价、生成回复稿）现在就能用；想用「标记成功 / 优化话术」，请完全退出并重开一次 WorkBuddy。';
  } else {
    level = 'connected';
    message = '已连上 WorkBuddy，全部功能可用';
    hint = '在 WorkBuddy 里说「查看客服助手状态」或「帮我优化话术」即可。';
  }

  const checks = [
    { name: '连接器已登记且处于启用状态', ok: configured },
    { name: '信任记录已写好（不用再点信任）', ok: trusted },
    { name: 'WorkBuddy 已加载客服助手工具', ok: loaded },
    { name: '新增的学习 / 优化工具已加载', ok: newToolsLoaded },
  ];
  return { level, message, hint, checks, tool_list_file: path.join(dir, 'mcp-tool-list.json') };
}

export default async function learningRoute(app: FastifyInstance): Promise<void> {
  /** 界面右上角「检查 WorkBuddy 连接」按钮打这里 */
  app.get('/v1/workbuddy/status', async () => workbuddyStatus());

  /** 聊天记录 / 学习样本列表 */
  app.get('/v1/learning/records', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>;
    const rows = listLearningRecords(
      { label: q.label, intent: q.intent, q: q.q },
      Math.min(Number(q.limit ?? 30), 200),
    );
    return {
      object: 'list',
      data: rows.map((r) => ({
        id: r.id,
        时间: new Date(r.created_at).toLocaleString('zh-CN', { hour12: false }),
        标记: r.label === 'success' ? '成功' : r.label === 'failure' ? '失败' : '未标记',
        label: r.label,
        场景: intentInfo(r.intent).label,
        intent: r.intent,
        国家: r.country,
        产品: r.product,
        客户消息: r.customer_text.slice(0, 160),
        回复稿: r.draft_text.slice(0, 400),
        原因: r.note,
        来源: r.source === 'import' ? '导入案例' : r.source === 'workbuddy' ? 'WorkBuddy 整理' : '使用记录',
        session_id: r.session_id,
      })),
      stats: learningStats(),
    };
  });

  /** 标记成功 / 失败（可按记录编号，也可按会话自动取最近一次） */
  app.post('/v1/learning/mark', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label = String(body.label ?? '');
    if (label !== 'success' && label !== 'failure') {
      return reply.code(400).send({ error: { message: 'label 只能是 success（成功）或 failure（失败）', type: 'invalid_request_error' } });
    }
    let id = String(body.id ?? '');
    if (!id && body.session_id) {
      id = latestRecordBySession(String(body.session_id))?.id ?? '';
    }
    if (!id) return reply.code(404).send({ error: { message: '没找到要标记的记录，请先生成一次回复稿', type: 'not_found' } });
    const before = getLearningRecord(id);
    if (!before) return reply.code(404).send({ error: { message: `找不到记录 ${id}`, type: 'not_found' } });

    const note = String(body.note ?? '').trim();
    rateLearningRecord(id, label, note);
    const after = getLearningRecord(id)!;
    syncCase(after);
    // 每次标记后立刻归纳，下次起草就能用上（也可以手动调 /v1/scripts/rebuild）
    const { summary } = rebuildScriptBook();
    return reply.send({
      ok: true,
      id,
      label,
      提示: label === 'success' ? '已记为成功案例，并写进案例库' : '已记为失败案例，已从案例库撤出',
      script_summary: summary,
    });
  });

  app.post('/v1/learning/delete', async (req, reply) => {
    const id = String(((req.body ?? {}) as Record<string, unknown>).id ?? '');
    if (!id) return reply.code(400).send({ error: { message: '缺少 id', type: 'invalid_request_error' } });
    deleteCase(`case_${id}`);
    return reply.send({ ok: deleteLearningRecord(id) });
  });

  app.get('/v1/learning/stats', async () => learningStats());

  /** WorkBuddy 或你自己整理好一段成功 / 失败对话，直接入库 */
  app.post('/v1/learning/import-case', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const customer = String(b.customer_text ?? b['客户消息'] ?? '').trim();
    const draft = String(b.draft_text ?? b['回复稿'] ?? b.reusable_script ?? '').trim();
    if (!customer || !draft) {
      return reply.code(400).send({ error: { message: '至少要给「客户消息」和「回复稿」两段文字', type: 'invalid_request_error' } });
    }
    const label = String(b.label ?? 'success') === 'failure' ? 'failure' : 'success';
    const id = insertLearningRecord({
      source: 'workbuddy',
      label,
      note: String(b.note ?? b['原因'] ?? '').trim(),
      intent: classifyIntent(`${customer} ${String(b.intent ?? '')}`),
      country: String(b.country ?? b['国家'] ?? ''),
      product: String(b.product ?? b['产品'] ?? ''),
      stage: String(b.stage ?? ''),
      customer_text: customer,
      draft_text: draft,
      attachments: Array.isArray(b.attachments) ? b.attachments.map(String) : [],
      agent: 'workbuddy',
    });
    const record = getLearningRecord(id)!;
    syncCase(record);
    const { summary } = rebuildScriptBook();
    return reply.send({ ok: true, id, label, 提示: label === 'success' ? '已入库为成功案例' : '已入库为失败案例', script_summary: summary });
  });

  /** 话术库：看 / 重新归纳 / 写入 WorkBuddy 的建议 */
  app.get('/v1/scripts', async () => ({ ok: true, file: scriptFilePath(), book: loadScriptBook() }));
  app.get('/v1/scripts/review', async () => ({ ok: true, text: scriptReviewText() }));
  app.post('/v1/scripts/rebuild', async () => {
    const { book, summary } = rebuildScriptBook();
    return { ok: true, summary, version: book['版本'], file: scriptFilePath() };
  });
  app.post('/v1/scripts/advice', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const lines = Array.isArray(b.advice) ? b.advice.map(String) : [String(b.advice ?? '')];
    const clean = lines.map((s) => s.trim()).filter(Boolean);
    const replaceMode = b.mode === 'replace';
    if (!clean.length && !replaceMode) return reply.code(400).send({ error: { message: 'advice 不能为空', type: 'invalid_request_error' } });
    // replace + 空数组 = 清空 WorkBuddy 建议（整理演示数据时用）
    const book = saveAdvice(clean, replaceMode ? 'replace' : 'append');
    return reply.send({ ok: true, version: book['版本'], count: book['WorkBuddy建议'].length, 提示: '已写入话术库，下一次生成回复稿时生效' });
  });

  /** 只读中文页面：点界面「看看学到的经验」打开，不需要口令 */
  app.get('/docs/scripts', async (_req, reply) => {
    const book = loadScriptBook();
    const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
    const list = (arr: string[]): string => arr.length
      ? '<ul>' + arr.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>'
      : '<span class="none">（暂无）</span>';
    const scenes = Object.entries(book['场景']).map(([, s]) => `
      <div class="card">
        <h3>${esc(s['场景名'])} <span class="tag">成功 ${s['成功数']} · 失败 ${s['失败数']}</span></h3>
        <p class="tip"><b>默认要点：</b>${esc(s['默认要点'])}</p>
        <p><b>已验证有效的话术</b></p>${list(s['成功话术'])}
        <p><b>要避免的写法</b></p>${list(s['避免'])}
        <p><b>经验教训</b></p>${list(s['经验教训'])}
      </div>`).join('');
    const st = book['统计'];
    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>话术库 · 客服回复助手</title>
<style>
body{font-family:"Microsoft YaHei","Segoe UI",system-ui,sans-serif;background:#f5f7fa;color:#1f2937;margin:0;padding:26px;line-height:1.7}
.wrap{max-width:900px;margin:0 auto}h1{font-size:22px;margin:0 0 6px}.sub{color:#6b7280;font-size:13px;margin-bottom:18px}
.sum{background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px 16px;margin-bottom:18px;font-size:14px}
.card{background:#fff;border:1px solid #e3e8ef;border-radius:10px;padding:14px 18px;margin-bottom:12px}
h3{font-size:15px;margin:0 0 8px}.tag{font-size:11px;color:#2563eb;background:#eff6ff;border-radius:99px;padding:2px 8px;margin-left:6px;font-weight:400}
.tip{background:#f8fafc;border-left:3px solid #2563eb;padding:8px 10px;font-size:13px}
p{font-size:13px;margin:10px 0 4px}ul{margin:4px 0;padding-left:20px;font-size:13px}li{margin:3px 0}
.none{color:#9ca3af;font-size:12px}.foot{color:#6b7280;font-size:12px;margin-top:20px;border-top:1px solid #e3e8ef;padding-top:12px}
code{background:#f1f5f9;padding:1px 5px;border-radius:4px}
</style></head><body><div class="wrap">
<h1>话术库 · 学到的经验</h1>
<div class="sub">版本 ${book['版本']} · 最后更新 ${esc(book['更新时间'])} · 这个页面只读</div>
<div class="sum"><b>学习情况：</b>共 ${st['总记录']} 条记录，已标记 ${st['已标记']} 条（成功 ${st['成功']} / 失败 ${st['失败']}），成功率 ${esc(st['成功率'])}。<br>
<b>总体偏好：</b>${esc(book['总体偏好'].join('；'))}<br><b>总体禁忌：</b>${esc(book['总体禁忌'].join('；'))}</div>
<h3 style="font-size:15px">WorkBuddy 给出的优化建议</h3>${list(book['WorkBuddy建议'])}
${scenes}
<div class="foot">怎么改：用记事本打开 <code>${esc(scriptFilePath())}</code>，改完保存即可，<b>不用重启</b>，下一次生成回复稿自动生效。<br>
也可以直接在 WorkBuddy 里说「帮我优化话术」，它会分析上面的数据并把建议写回来。<br>
安全提醒：历史价格、交期、日期都已被替换成占位符，实际数字必须查当前报价表；这里只学语气和结构。</div>
</div></body></html>`;
    return reply.type('text/html; charset=utf-8').send(html);
  });
}
