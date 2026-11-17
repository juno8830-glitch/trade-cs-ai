import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { splitDraft, sanitizeForeignDraft } from '@trade-cs-ai/core';

const base = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8787';
const token = process.env.CLIENT_TOKEN ?? 'dev-client-token-change-me';
const wechatToken = process.env.WECHAT_TOKEN ?? '';
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

/**
 * 体检只用「当前资料库里真实存在的型号」。
 * 以前写死演示数据（某铝合金型号 = 某美元价 / 第 2 行），一换成用户自己的库存表就必然失败；
 * 现在从整理出来的索引里挑一个型号，且只断言工具能返回真实文件名与行号，不断言具体价格。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function currentQuote(): { sku: string } | null {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '资料索引.json'), 'utf8'));
    const row = (idx.报价 ?? []).find(
      (q: { 价格: number | null; 型号: string }) =>
        q.价格 !== null && /^[A-Za-z][A-Za-z0-9]{2,}$/.test(String(q.型号 ?? '')),
    );
    return row ? { sku: String(row.型号) } : null;
  } catch {
    return null;
  }
}
const QUOTE = currentQuote();

/** 体检项目名给新手看中文；括号里的英文接口名留给技术同事排查 */
const CN: Record<string, string> = {
  'GET /v1/health': '后台服务是否正常运行',
  '鉴权：无 token 返回 401': '连接口令是否生效（没口令会被拦住）',
  'GET /v1/agents': 'AI 名单是否登记完整、兜底助手是否可用',
  'Router：按场景切换 Agent（只改 agents.yaml）': '自动挑选 AI：按客户阶段换人（只改配置）',
  'GET /v1/tools': '查资料的小帮手是否齐全',
  'POST /v1/tools/quote-lookup': '查报价表：能否读到真实价格和第几行',
  'POST /v1/tools/file-search': '找资料文件：能否返回真实文件路径',
  'POST /v1/cases/import + GET /v1/cases': '成功案例入库：缺字段的会被拒绝',
  'POST /v1/chat/completions（非流式）': '生成回复稿（一次性返回）与资料留痕',
  'POST /v1/chat/completions（SSE 流式帧）': '生成回复稿（逐字显示）',
  'POST /v1/agent/invoke（直连指定 Agent）': '指定某个 AI 单独调用',
  'WS /ws/stream + 企业微信回调推送 + 去重': '客户新消息推送与重复消息去重',
  '人工确认留痕 + M5 指标': '人工确认留痕与采纳率统计',
  '静态预览 /app/': '操作界面能否正常打开',
  '不同消息给不同回复': '不同客户消息能否拿到不同回复稿',
  'WorkBuddy 连接自检 + 话术库页面': 'WorkBuddy 连接状态检查与话术库页面',
  '标记成功/失败 → 话术自动优化': '标记成败后话术库与案例库是否同步更新',
  '中文翻译 / 纯草稿分块 / 重启按钮': '中文翻译、复制只含外文正文、顶部重启按钮',
  '第三方 AI 连接状态 / 智谱配置': '第三方 AI 是否连上（智谱密钥填对位置）',
  '外部 AI 格式容错（去重 / 思考标签 / 工具参数）': '外部 AI 输出格式容错与前后端工具参数完整',
  '资料库整理 / 索引 / 真实报价查询': '一键整理资料：读懂库存表，并按真实型号查到价格与来源行号',
  '界面资料库面板 / 唤起快捷键': '一键整理按钮、资料库状态、启动菜单与 Ctrl+Shift+X 快捷键',
  '外文正文中文文件名清洗': '发给客户的外文正文不会带中文文件名或中文说明',
};
const cn = (name: string): string => CN[name] ?? name;

function pass(name: string, detail = 'ok'): void {
  results.push({ name: cn(name), ok: true, detail });
  console.log(`  通过    ${cn(name)} — ${detail}`);
}
function fail(name: string, detail: string): void {
  results.push({ name: cn(name), ok: false, detail });
  console.log(`  未通过  ${cn(name)} — ${detail}`);
}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    fail(name, (e as Error).message);
  }
}

async function api(path: string, init: RequestInit = {}, withToken = true): Promise<Response> {
  return fetch(base + path, {
    ...init,
    headers: {
      ...(withToken ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

const TOOLS = [
  { type: 'function', function: { name: 'file_search', description: '按型号+资料类型检索客服资料库' } },
  { type: 'function', function: { name: 'quote_lookup', description: '读取报价表价格/MOQ/交期' } },
  { type: 'function', function: { name: 'case_search', description: '检索成功案例库' } },
];

const context = {
  session_id: 's_smoke_001',
  customer: { country: 'MX', type: 'trader', stage: 'sample_done', name: 'Carlos' },
  channel: 'wechat',
  locale: 'es-MX',
};

const chatPayload = {
  // 体检固定用内置兜底助手：结果稳定、不联网、不消耗用户的 API 额度。
  // 真实联网 AI 的连通性由下面「第三方 AI 连接状态 / 智谱配置」单独检查。
  model: 'builtin-offline',
  messages: [
    {
      role: 'user',
      content: `客户问 ${QUOTE?.sku ?? '这款现货'} 的报价和交期，还要产品图片，并想看成功案例。`,
    },
  ],
  stream: false,
  temperature: 0.4,
  tools: TOOLS,
  context,
};

async function main(): Promise<void> {
  console.log(`\n【体检】正在检查：${base}\n`);

  await test('GET /v1/health', async () => {
    const r = await api('/v1/health', {}, false);
    expect(r.status === 200, `HTTP ${r.status}`);
    const j: any = await r.json();
    expect(j.status === 'ok', 'gateway not ok');
    expect(j.agents_healthy >= 1, 'no healthy agent');
    pass('GET /v1/health', `${j.agents_healthy}/${j.agents_total} 个 AI 可用，资料文件夹已就绪=${j.kb_exists}`);
  });

  await test('鉴权：无 token 返回 401', async () => {
    const r = await api('/v1/agents', {}, false);
    expect(r.status === 401, `HTTP ${r.status}`);
    pass('鉴权：无 token 返回 401');
  });

  await test('GET /v1/agents', async () => {
    const r = await api('/v1/agents');
    const j: any = await r.json();
    expect(Array.isArray(j.data) && j.data.length >= 5, `agents=${j.data?.length}`);
    const offline = j.data.find((a: any) => a.id === 'builtin-offline');
    expect(offline?.healthy === true, 'builtin-offline unhealthy');
    pass('GET /v1/agents', `${j.data.length} 个已注册，兜底 Agent 健康`);
  });

  await test('第三方 AI 连接状态 / 智谱配置', async () => {
    const r = await api('/v1/agents?refresh=1');
    expect(r.status === 200, `HTTP ${r.status}`);
    const j: any = await r.json();
    const z = j.data.find((a: any) => a.id === 'zhipu-glm');
    expect(Boolean(z), 'agents.yaml 里没有智谱专用条目 zhipu-glm');
    expect(/^glm-/.test(String(z.model ?? '')), `智谱模型名不对: ${z.model}`);
    const env = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
    const hasKey = /^ZHIPU_API_KEY\s*=\s*\S+/m.test(env);
    if (hasKey) expect(z.healthy === true, `已填智谱密钥却显示没连上：${z.detail}`);
    else expect(z.healthy === false && /missing credential/.test(String(z.detail ?? '')), `未填密钥时状态异常：${z.detail}`);
    expect(Boolean(j.data.find((a: any) => a.id === 'openai-thirdparty')), '缺少 OpenAI / 第三方条目');
    pass('第三方 AI 连接状态 / 智谱配置', hasKey ? `智谱 ${z.model} 已连上 ✓（密钥在专用栏）` : '未填智谱密钥，专用条目已就位且状态正确');
  });

  await test('外部 AI 格式容错（去重 / 思考标签 / 工具参数）', async () => {
    const dirty = [
      '【回复稿】', 'Hola Carlos,', '【中文翻译】', '卡洛斯，您好：',
      '【中文说明】', '来源：报价表第 2 行', '</think>',
      '【回复稿】', 'Hola Carlos,', '【中文翻译】', '卡洛斯，您好：',
    ].join('\n');
    const s = splitDraft(dirty);
    expect(s.clean === 'Hola Carlos,', `重复结构没去掉: ${JSON.stringify(s.clean)}`);
    expect(!s.clean.includes('</think>') && !s.notes.includes('</think>'), '思考标签没清掉');
    expect(s.translation === '卡洛斯，您好：', '中文翻译分段不对');
    const toolsRes: any = await (await api('/v1/tools')).json();
    expect(toolsRes.data.every((t: any) => t.function?.parameters?.type === 'object'), '网关工具清单缺少 parameters');
    const app = fs.readFileSync('apps/desktop/src/renderer/app.js', 'utf8');
    const i = app.indexOf("name: 'quote_lookup'");
    expect(i >= 0 && app.slice(i, i + 400).includes('parameters'), '界面工具清单缺少 parameters（外部 AI 会报参数有误）');
    pass('外部 AI 格式容错（去重 / 思考标签 / 工具参数）', '重复结构只留一份、思考标签已清除、前后端工具参数齐全');
  });

  await test('Router：按场景切换 Agent（只改 agents.yaml）', async () => {
    // 现在外部 AI 可能已连上并参与自动挑选；体检里明确指定两个内置 Agent，
    // 既验证「不同场景 / 不同 AI 都能起草」，又避免每次体检都调用付费接口。
    const mk = (scenario: string, session: string, model: string) => ({
      ...chatPayload,
      model,
      messages: [{ role: 'user', content: '请起草一封跟进邮件' }],
      context: { ...context, session_id: session, scenario },
    });
    const r1 = await api('/v1/chat/completions', { method: 'POST', body: JSON.stringify(mk('draft_only', 's_route_draft', 'offline-draft')) });
    const j1: any = await r1.json();
    expect(j1.x_meta?.agent === 'offline-draft', `draft_only → ${j1.x_meta?.agent}`);
    const r2 = await api('/v1/chat/completions', { method: 'POST', body: JSON.stringify(mk('negotiate', 's_route_negotiate', 'builtin-offline')) });
    const j2: any = await r2.json();
    expect(j2.x_meta?.agent === 'builtin-offline', `negotiate → ${j2.x_meta?.agent}`);
    pass('Router：按场景切换 Agent（只改 agents.yaml）', `draft_only → ${j1.x_meta.agent}；negotiate → ${j2.x_meta.agent}`);
  });

  await test('GET /v1/tools', async () => {
    const r = await api('/v1/tools');
    const j: any = await r.json();
    const names = (j.data ?? []).map((t: any) => t.function?.name);
    for (const n of ['file_search', 'quote_lookup', 'library_search', 'case_search']) {
      expect(names.includes(n), `工具清单缺少 ${n}`);
    }
    for (const t of j.data ?? []) {
      expect(t.function?.parameters?.type === 'object', `${t.function?.name} 缺少 parameters（外部 AI 会报参数错误）`);
    }
    pass('GET /v1/tools', `${j.data.length} 个工具定义，参数说明齐全`);
  });

  await test('POST /v1/tools/quote-lookup', async () => {
    const sku = QUOTE?.sku ?? '库存';
    const r = await api('/v1/tools/quote-lookup', { method: 'POST', body: JSON.stringify({ sku }) });
    const j: any = await r.json();
    expect(j.ok === true, JSON.stringify(j));
    expect(Boolean(j.data.file) && Number(j.data.row) >= 1, '必须返回真实文件名与来源行号');
    pass('POST /v1/tools/quote-lookup', `型号 ${sku} → ${j.data.file} 第 ${j.data.row} 行，价格 ${j.data.price ?? j.data.price_usd} ${j.data.currency ?? ''}`);
  });

  await test('POST /v1/tools/file-search', async () => {
    const r = await api('/v1/tools/file-search', { method: 'POST', body: JSON.stringify({ sku: '库存', kind: 'quote' }) });
    const j: any = await r.json();
    expect(j.ok === true && j.data.files.length >= 1, JSON.stringify(j));
    pass('POST /v1/tools/file-search', `命中 ${j.data.files.length} 个真实文件：${j.data.files[0].path}`);
  });

  await test('POST /v1/cases/import + GET /v1/cases', async () => {
    const cases = [
      { id: 'smoke_mx_1', country: 'MX', product: '现货', reusable_script: '先确认型号再按当前库存表报价', attachments: ['报价表.xlsx'], updated_at: '2026-11-13' },
      { id: 'smoke_es_2', country: 'ES', product: '现货', reusable_script: '跟进时给明确的下一步', attachments: ['库存表.xlsx'], updated_at: '2026-11-13' },
      { id: 'smoke_bad', country: 'MX' },
    ];
    const r = await api('/v1/cases/import', { method: 'POST', body: JSON.stringify({ format: 'json', cases }) });
    const j: any = await r.json();
    expect(j.imported === 2 && j.skipped === 1, JSON.stringify(j));
    const r2 = await api('/v1/cases?country=MX');
    const j2: any = await r2.json();
    expect(j2.data.length >= 1, 'MX case not found');
    pass('POST /v1/cases/import + GET /v1/cases', `入库 ${j.imported} / 拒绝 ${j.skipped}（缺字段案例不入库）`);
  });

  let nonStream: any;
  await test('POST /v1/chat/completions（非流式）', async () => {
    const r = await api('/v1/chat/completions', { method: 'POST', body: JSON.stringify(chatPayload) });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    nonStream = await r.json();
    expect(nonStream.object === 'chat.completion', 'not OpenAI shape');
    expect(nonStream.choices?.[0]?.message?.content?.includes('【回复稿】'), 'missing draft');
    expect(nonStream.x_meta?.agent === 'builtin-offline', `agent=${nonStream.x_meta?.agent}`);
    const names = (nonStream.x_meta?.tools_called ?? []).map((t: any) => t.name);
    expect(names.includes('quote_lookup'), `tools=${names}`);
    expect(names.includes('file_search'), `tools=${names}`);
    expect(names.includes('case_search'), `tools=${names}`);
    expect(nonStream.x_meta?.need_human_confirm === true, 'need_human_confirm false');
    expect(nonStream.x_meta?.price_sensitive === true, 'price_sensitive false');
    expect(nonStream.usage?.prompt_tokens > 0, 'missing usage');
    pass('POST /v1/chat/completions（非流式）', `agent=${nonStream.x_meta.agent}, tools=[${names}], 耗时 ${nonStream.x_meta.latency_ms}ms`);
  });

  await test('中文翻译 / 纯草稿分块 / 重启按钮', async () => {
    const content = String(nonStream?.choices?.[0]?.message?.content ?? '');
    expect(content.includes('【回复稿】'), '回复稿缺少【回复稿】标记');
    expect(content.includes('【中文翻译】'), '回复稿缺少中文翻译');
    expect(content.includes('【中文说明】'), '回复稿缺少中文说明');
    const clean = String(nonStream?.x_meta?.clean_draft ?? '');
    const zh = String(nonStream?.x_meta?.translation ?? '');
    expect(clean.length > 40, '纯草稿为空');
    expect(!clean.includes('【中文翻译】') && !clean.includes('【中文说明】') && !clean.includes('【资料来源】'), '纯草稿混入了中文注解标记');
    expect(!/[\u4e00-\u9fa5]/.test(clean), '纯草稿里还残留中文，复制给客户会出洋相');
    expect(/[\u4e00-\u9fa5]/.test(zh) && zh.length > 20, '中文翻译为空');
    const page = await (await fetch(base + '/app/')).text();
    expect(page.includes('btnRestart'), '界面顶部缺少「重启程序」按钮');
    expect(page.includes('translationBox') && page.includes('notesBox'), '界面缺少中文翻译 / 注解显示区');
    pass('中文翻译 / 纯草稿分块 / 重启按钮', `外文正文 ${clean.length} 字、中文翻译 ${zh.length} 字，复制内容不含中文`);
  });

  await test('POST /v1/chat/completions（SSE 流式帧）', async () => {
    const r = await api('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ ...chatPayload, stream: true }) });
    expect(r.status === 200, `HTTP ${r.status}`);
    const text = await r.text();
    const frames = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter((l) => l && l !== '[DONE]')
      .map((l) => JSON.parse(l));
    const types = [...new Set(frames.map((f: any) => f.type))];
    expect(types.includes('delta'), `types=${types}`);
    expect(types.includes('tool_call'), `types=${types}`);
    expect(types.includes('tool_result'), `types=${types}`);
    expect(types.includes('meta'), `types=${types}`);
    expect(types.includes('done'), `types=${types}`);
    expect(text.includes('data: [DONE]'), 'missing [DONE]');
    const deltas = frames.filter((f: any) => f.type === 'delta');
    expect(deltas.length >= 3, `只回传 ${deltas.length} 个 delta，流式退化`);
    pass('POST /v1/chat/completions（SSE 流式帧）', `${frames.length} 帧（${deltas.length} 个 delta），类型 [${types.join(',')}]`);
  });

  await test('POST /v1/agent/invoke（直连指定 Agent）', async () => {
    const r = await api('/v1/agent/invoke', {
      method: 'POST',
      body: JSON.stringify({ agent_id: 'builtin-offline', request: { messages: [{ role: 'user', content: '请起草一封跟进邮件' }] } }),
    });
    const j: any = await r.json();
    expect(j.choices?.[0]?.message?.content?.includes('【回复稿】'), JSON.stringify(j).slice(0, 200));
    const r2 = await api('/v1/agent/invoke', { method: 'POST', body: JSON.stringify({ agent_id: 'not-exist', request: { messages: [{ role: 'user', content: 'x' }] } }) });
    expect(r2.status === 404, `unknown agent HTTP ${r2.status}`);
    pass('POST /v1/agent/invoke（直连指定 Agent）', '直连成功，未知 Agent 返回 404');
  });

  await test('WS /ws/stream + 企业微信回调推送 + 去重', async () => {
    const wsUrl = `${base.replace(/^http/, 'ws')}/ws/stream?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    const frames: any[] = [];
    const waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void; timer: NodeJS.Timeout }> = [];
    ws.on('message', (raw) => {
      let f: any;
      try { f = JSON.parse(String(raw)); } catch { return; }
      frames.push(f);
      for (const w of [...waiters]) {
        if (w.pred(f)) {
          waiters.splice(waiters.indexOf(w), 1);
          clearTimeout(w.timer);
          w.resolve(f);
        }
      }
    });
    const waitFor = (pred: (f: any) => boolean, ms = 15000): Promise<any> =>
      new Promise((resolve, reject) => {
        const existing = frames.find(pred);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error('WS wait timeout')), ms);
        waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); }, timer });
      });

    try {
      await waitFor((f) => f.type === 'push' && f.event === 'connected');
      ws.send(JSON.stringify({ type: 'request', payload: { ...chatPayload, stream: true } }));
      const done = await waitFor((f) => f.type === 'done');
      expect(done, 'no done frame');
      const deltas = frames.filter((f) => f.type === 'delta');
      expect(deltas.length >= 3, `WS 只回传 ${deltas.length} 个 delta，流式退化`);

      const body: any = {
        msgid: 'smoke_msg_' + Date.now(),
        from: 'Carlos (MX)',
        text: { content: `Hola, ¿cuál es el precio de ${QUOTE?.sku ?? 'este stock'}?` },
        session_id: 's_smoke_wx_001',
        customer: { country: 'MX', type: 'trader', stage: 'sample_done', name: 'Carlos' },
        locale: 'es-MX',
      };
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (wechatToken) headers['x-signature'] = crypto.createHmac('sha256', wechatToken).update(JSON.stringify(body)).digest('hex');
      const r = await fetch(base + '/ingress/wechat/callback', { method: 'POST', headers, body: JSON.stringify(body) });
      const j: any = await r.json();
      expect(j.ok === true && j.clients_notified >= 1, JSON.stringify(j).slice(0, 250));

      const push = await waitFor((f) => f.type === 'push' && f.event === 'wechat_message');
      expect(push.data?.suggestion?.includes('【回复稿】'), 'push missing suggestion');

      const r2 = await fetch(base + '/ingress/wechat/callback', { method: 'POST', headers, body: JSON.stringify(body) });
      const j2: any = await r2.json();
      expect(j2.duplicate === true, `dedupe failed: ${JSON.stringify(j2)}`);
      pass('WS /ws/stream + 企业微信回调推送 + 去重', `流式 ${deltas.length} delta，推送 1 条，重复消息被去重`);
    } finally {
      ws.close();
    }
  });

  await test('人工确认留痕 + M5 指标', async () => {
    const r = await api('/v1/audit/sent', { method: 'POST', body: JSON.stringify({ session_id: context.session_id, operator: 'smoke', confirmed: true }) });
    const j: any = await r.json();
    expect(j.ok === true, JSON.stringify(j));
    const r2 = await api('/v1/metrics');
    const m: any = await r2.json();
    expect(m.total_suggestions >= 2, JSON.stringify(m));
    expect(m.sent_count >= 1, 'sent not recorded');
    expect(m.adoption_rate > 0, 'adoption rate zero');
    pass('人工确认留痕 + M5 指标', `建议 ${m.total_suggestions} 条，采纳 ${m.sent_count} 条，采纳率 ${(m.adoption_rate * 100).toFixed(1)}%`);
  });

  await test('WorkBuddy 连接自检 + 话术库页面', async () => {
    const r = await api('/v1/workbuddy/status');
    expect(r.status === 200, `HTTP ${r.status}`);
    const j: any = await r.json();
    expect(['connected', 'needs_restart', 'not_configured'].includes(j.level), `level=${j.level}`);
    expect(Array.isArray(j.checks) && j.checks.length === 4, '检查项不完整');
    const r2 = await fetch(base + '/docs/scripts');
    expect(r2.status === 200, `话术库页面 HTTP ${r2.status}`);
    expect((await r2.text()).includes('话术库'), '话术库页面内容不对');
    pass('WorkBuddy 连接自检 + 话术库页面', `状态=${j.level}，4 项检查可读，话术库页面可打开`);
  });

  await test('标记成功/失败 → 话术自动优化', async () => {
    const r = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ ...chatPayload, context: { ...context, session_id: 's_learn_smoke' } }),
    });
    const j: any = await r.json();
    const id = String(j.x_meta?.suggestion_id ?? '');
    expect(Boolean(id), '回复结果缺少学习记录编号 suggestion_id');

    const m1 = await api('/v1/learning/mark', { method: 'POST', body: JSON.stringify({ id, label: 'success', note: '体检用：模拟成功' }) });
    expect(m1.status === 200, `标记成功 HTTP ${m1.status}`);
    const s1: any = await (await api('/v1/scripts')).json();
    expect(Object.keys(s1.book['场景']).some((k: string) => s1.book['场景'][k]['成功数'] > 0), '话术库没学到成功样本');
    const c1: any = await (await api('/v1/cases?limit=100')).json();
    expect(c1.data.some((c: any) => c.id === `case_${id}`), '成功案例没有写进案例库');

    const m2 = await api('/v1/learning/mark', { method: 'POST', body: JSON.stringify({ id, label: 'failure', note: '体检用：模拟改判失败' }) });
    expect(m2.status === 200, `改判失败 HTTP ${m2.status}`);
    const c2: any = await (await api('/v1/cases?limit=100')).json();
    expect(!c2.data.some((c: any) => c.id === `case_${id}`), '改判失败后案例没从案例库撤出');

    // 体检不留假数据：删掉这条记录并重新归纳
    await api('/v1/learning/delete', { method: 'POST', body: JSON.stringify({ id }) });
    await api('/v1/scripts/rebuild', { method: 'POST', body: '{}' });
    pass('标记成功/失败 → 话术自动优化', `记录 ${id} 成功→失败，话术库与案例库同步更新，体检数据已清理`);
  });

  await test('不同消息给不同回复', async () => {
    const make = async (text: string) => {
      const r = await api('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          ...chatPayload,
          messages: [{ role: 'user', content: text }],
          context: { ...context, session_id: 's_variety_smoke' },
        }),
      });
      const j: any = await r.json();
      return { content: String(j.choices?.[0]?.message?.content ?? ''), id: String(j.x_meta?.suggestion_id ?? '') };
    };
    const a = await make('有空吗？');
    const b = await make('Can you speak English');
    expect(a.content && b.content, '回复稿为空');
    expect(a.content !== b.content, '两条不同消息拿到了同一份回复稿');
    expect(a.content.includes('本次识别') && b.content.includes('本次识别'), '中文说明没写出本次识别的场景');
    // 体检不留假数据
    for (const id of [a.id, b.id]) if (id) await api('/v1/learning/delete', { method: 'POST', body: JSON.stringify({ id }) });
    await api('/v1/scripts/rebuild', { method: 'POST', body: '{}' });
    pass('不同消息给不同回复', '闲聊细分生效，体检数据已清理');
  });

  await test('资料库整理 / 索引 / 真实报价查询', async () => {
    const st = await api('/v1/library/status');
    expect(st.status === 200, `资料库状态接口 HTTP ${st.status}`);
    const org = await api('/v1/library/organize', { method: 'POST', body: '{}' });
    expect(org.status === 200, `一键整理接口 HTTP ${org.status}`);
    const o: any = await org.json();
    expect(o.ok === true, '整理没成功：' + (o.摘要 || ''));
    expect(o.统计?.型号数 > 0 && o.统计?.报价行数 > 0, '没有识别出任何型号或报价行');
    expect(o.耗时毫秒 < 8000, `整理耗时 ${o.耗时毫秒}ms，可能退化成全量读大文件`);
    const rd: any = await (await api('/v1/library/ready')).json();
    expect(rd.ready === true && rd.models > 0, '索引没有落盘');

    // 从索引里挑一个真实型号，确认查价走的是用户自己的表，不是示例表
    const idx = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', '资料索引.json'), 'utf8'));
    const real = (idx.型号目录 as any[]).find((m) => /[A-Za-z]/.test(m.型号));
    expect(real, '索引里没有可用的型号');
    const qj: any = await (await api('/v1/tools/quote-lookup', {
      method: 'POST', body: JSON.stringify({ sku: real.型号 }),
    })).json();
    expect(qj.ok === true && qj.data?.price !== undefined, `按真实型号 ${real.型号} 没查到报价：${qj.data?.hint || ''}`);
    expect(qj.data?.file && qj.data?.row > 0, '查价结果缺少来源文件或行号');
    const lj: any = await (await api('/v1/library/search?keyword=' + encodeURIComponent(real.型号))).json();
    expect(lj.ok === true, '资料库关键词检索没命中');
    const tools: any = await (await api('/v1/tools')).json();
    expect((tools.data ?? []).some((t: any) => t.function?.name === 'library_search'), '工具清单缺少 library_search');
    pass(
      '资料库整理 / 索引 / 真实报价查询',
      `${o.统计.型号数} 个型号 / ${o.统计.报价行数} 行；抽查 ${real.型号} → ${qj.data.price} ${qj.data.currency}（${qj.data.file} 第 ${qj.data.row} 行）`,
    );
  });

  await test('界面资料库面板 / 唤起快捷键', async () => {
    const root = process.cwd();
    const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
    const html = read('apps/desktop/src/renderer/index.html');
    const js = read('apps/desktop/src/renderer/app.js');
    const main = read('apps/desktop/src/main/index.js');
    const menu = read('scripts/start.js');
    for (const id of ['btnOrganize', 'btnViewList', 'btnOpenKb', 'kbSummary', 'kbMsg']) {
      expect(html.includes(id), `界面缺少 ${id}`);
    }
    expect(js.includes('/v1/library/organize') && js.includes("btnOrganize').onclick"), '整理按钮没接上后端');
    expect(main.includes("const HOTKEY = 'CommandOrControl+Shift+X'"), '唤起快捷键没有改成 Ctrl+Shift+X');
    expect(main.includes('Ctrl+Shift+X 唤起'), '托盘提示没有同步改');
    expect(menu.includes('10 🗂 整理我的资料库'), '启动菜单缺少整理资料选项');
    expect(read('使用说明书.html').includes('id="s16"'), '说明书缺少第 16 节');
    const online = await (await fetch(base + '/app/')).text();
    expect(online.includes('btnOrganize'), '在线界面没有资料库面板');
    pass('界面资料库面板 / 唤起快捷键', '按钮、状态、菜单 10、说明书第 16 节与 Ctrl+Shift+X 均在位');
  });

  await test('外文正文中文文件名清洗', async () => {
    const dirty = [
      'Hola, abra el archivo "资料库清单.md" para ver las fotos.',
      'El precio es 9.9 CNY por pieza.',
      '请人工核对价格后再发送。',
    ].join('\n');
    const clean = sanitizeForeignDraft(dirty);
    expect(!/[\u4e00-\u9fa5]/.test(clean), '清洗后仍含中文：' + clean);
    expect(clean.includes('9.9 CNY'), '误删了正常的外文价格内容');
    expect(!clean.includes('请人工核对'), '没删掉中文说明行');
    pass('外文正文中文文件名清洗', '中文文件名被替换、中文说明行被移除，西语价格保留');
  });

  await test('静态预览 /app/', async () => {
    const r = await fetch(base + '/app/');
    expect(r.status === 200, `HTTP ${r.status}`);
    const html = await r.text();
    expect(html.includes('客服回复助手'), '界面页面没有正确返回');
    expect(html.includes('wbNotice') && html.includes('btnToWorkBuddy'), '缺少「连上但回复一样」的说明或交给 WorkBuddy 的按钮');
    expect(html.includes('连接器：检查中'), '状态标签文案会造成「回复由 WorkBuddy 生成」的误解');
    pass('静态预览 /app/', '桌面端渲染层可由网关同源提供，防误导说明与出口按钮齐全');
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n【体检结果】共 ${results.length} 项，通过 ${results.length - failed.length} 项，未通过 ${failed.length} 项`);
  if (failed.length) {
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log('程序一切正常，可以开始使用。');
}

main().catch((e) => {
  console.error('【体检中断】', e);
  process.exit(1);
});
