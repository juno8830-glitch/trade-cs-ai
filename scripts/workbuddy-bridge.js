/**
 * WorkBuddy 桥接器（MCP 服务器，本地进程方式）
 *
 * 作用：让 WorkBuddy 直接调用这台电脑上的「客服回复助手」——
 *       查报价表、找资料文件、查成功案例、生成回复稿。
 * 方向：WorkBuddy →（这个桥）→ 本机后台服务 → 你的资料库
 * 红线：只生成回复稿，绝不发送任何消息给客户；价格必须人工核对。
 *
 * 配置文件在 ~/.workbuddy/mcp.json，由 WorkBuddy 负责启动本进程。
 * 所有日志只写「错误输出」，正常输出留给 MCP 协议，不能混。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 读取项目自己的 .env，密钥不写进 WorkBuddy 的配置里 */
function readEnv() {
  const out = {};
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 1) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = readEnv();
const BASE = (env.GATEWAY_URL || `http://127.0.0.1:${env.PORT || 8787}`).replace(/\/$/, '');
const TOKEN = env.CLIENT_TOKEN || 'dev-client-token-change-me';

const OFFLINE_HINT =
  '后台服务没连上。请先双击项目里的「一键启动.bat」，输入 1 回车，保持那个黑窗口开着，再回来重试。';
const SAFETY =
  '【安全提醒】价格、交期、账期等必须打开来源文件人工核对；这里只生成草稿，不会、也不能替你把消息发给客户。';
const AGENT_CN = {
  'self-hosted-graph': '公司自研 AI',
  'bailian-qwen': '阿里云通义千问',
  'openai-thirdparty': 'OpenAI / 第三方',
  'local-llama': '本机免费模型',
  'offline-draft': '离线起草助手',
  'builtin-offline': '内置兜底助手',
};

async function callGateway(pathname, method = 'GET', body) {
  try {
    const r = await fetch(BASE + pathname, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, error: `后台服务返回错误（${r.status}）：${text.slice(0, 200)}` };
    return { ok: true, data: text ? JSON.parse(text) : {} };
  } catch (e) {
    return { ok: false, error: `${OFFLINE_HINT}（技术信息：${e && e.message ? e.message : e}）` };
  }
}

const failed = (r) => ({ text: r.error || '调用失败', isError: true });
const json = (v) => JSON.stringify(v, null, 2);

/** 所有工具的实际逻辑；导出方便本地自检时不启动 MCP 进程也能测 */
export async function runTool(name, args = {}) {
  if (name === 'gateway_status') {
    const r = await callGateway('/v1/health');
    if (!r.ok) return failed(r);
    const d = r.data;
    return {
      text:
        `后台服务：${d.status === 'ok' ? '正常' : '异常'}\n` +
        `已登记的 AI：${d.agents_total} 个，其中 ${d.agents_healthy} 个当前可用\n` +
        `资料文件夹：${d.kb_exists ? '已就绪' : '不存在（请先运行一键启动生成示例资料）'}\n` +
        `资料库关联：${d.kb_index?.ready ? `已整理 ${d.kb_index.models} 个型号 / ${d.kb_index.rows} 行报价` : '还没整理（说「整理资料库」即可）'}\n` +
        `资料位置：${d.kb_root}\n` +
        `各 AI 状态：${(d.agents || []).map((a) => `${AGENT_CN[a.id] || a.id}（${a.healthy ? '可用' : '暂不可用'}）`).join('、')}\n` +
        SAFETY,
    };
  }

  if (name === 'lookup_quote') {
    const r = await callGateway('/v1/tools/quote-lookup', 'POST', { sku: args.sku });
    if (!r.ok) return failed(r);
    const d = r.data;
    if (!d.ok) return { text: `没查到型号 ${args.sku} 的报价。${d.data?.hint || ''}${SAFETY}` };
    const q = d.data;
    return {
      text:
        `查到型号 ${q.sku} 的真实资料（币种以 currency 为准，别当成美元）：\n` +
        `价格 ${q.price ?? q.price_usd} ${q.currency}${q.price_raw ? `（原表写作 ${q.price_raw}）` : ''}；` +
        `货期 ${q.lead_time || '未填'}；起订量 ${q.moq || '未填'}；系列 ${q.series || '未填'}。\n` +
        (q.extra_prices ? `同款其他规格价：${q.extra_prices}\n` : '') +
        (q.match_count > 1
          ? `共 ${q.match_count} 行匹配，前几行：\n${(q.matches || []).map((m) => `  · 第 ${m.行号} 行 ${m.规格 || ''} ${m.价格 ?? '未填'} ${m.币种}`).join('\n')}\n`
          : '') +
        `来源文件：${q.file}，工作表 ${q.sheet}，第 ${q.row} 行（请打开原文件核对这一行）。\n` +
        (q.recognition === '宽松识别' ? '⚠ 这条是按「无标准表头」的款式表推测的，必须核对原表。\n' : '') +
        `${q.price_note || ''}\n` +
        `原始数据：${json(q)}\n` +
        SAFETY,
    };
  }

  if (name === 'image_match_quote') {
    const body = {
      ...(args.image ? { image: args.image } : {}),
      ...(args.image_path ? { image_path: args.image_path } : {}),
      limit: args.limit || 5,
    };
    const r = await callGateway('/v1/tools/image-match-quote', 'POST', body);
    if (!r.ok) return failed(r);
    const d = r.data;
    const data = d.data || d;
    if (!data.ok) {
      return {
        text: `图片比对没有可用结果。${data.hint || d.hint || ''}\n` +
          '如果提示还没有图片索引，请先在客服助手界面把鼠标移到「加图片」按钮上，点「重建图片索引」。\n' + SAFETY,
        isError: true,
      };
    }
    const lines = (data.候选 || []).map((m, i) =>
      `  ${i + 1}. 型号 ${m.型号 || '（这张图没关联型号）'}｜相似度 ${Math.round((m.相似度 || 0) * 100)}%（${m.置信度}置信）｜` +
      `出厂价 ${m.价格原文 || m.价格 || '原表未填'} ${m.币种 || ''}｜货期 ${m.货期 || '未填'}｜` +
      `来源 ${m.文件} 工作表「${m.工作表}」第 ${m.行号} 行（${m.关联方式}）`,
    );
    return {
      text:
        `按图比对结果（库内 ${data.索引图片数 ?? '?'} 张产品图，耗时 ${data.耗时毫秒 ?? '?'} 毫秒）：\n` +
        lines.join('\n') + '\n' +
        `${data.hint || ''}\n${data.price_note || ''}\n` +
        '这些是「最像的几张」候选，不是最终判定；请照来源行号打开原表核对。\n' + SAFETY,
    };
  }

  if (name === 'find_files') {
    const body = { keyword: args.keyword, ...(args.kind ? { kind: args.kind } : {}) };
    const r = await callGateway('/v1/tools/file-search', 'POST', body);
    if (!r.ok) return failed(r);
    const d = r.data;
    const files = d.data?.files || [];
    return {
      text:
        (d.ok
          ? `找到 ${files.length} 个资料文件：\n${files.map((f) => `- ${f.path}（${f.name}）`).join('\n')}`
          : `没找到匹配资料。${d.data?.hint || ''} 请不要编造文件名。`) +
        `\n原始数据：${json(d)}\n` +
        SAFETY,
    };
  }

  if (name === 'library_status') {
    const r = await callGateway('/v1/library/status');
    if (!r.ok) return failed(r);
    const d = r.data;
    return {
      text:
        `【资料库关联状态】${d.已整理 ? '已关联' : '尚未整理'}\n` +
        (d.已整理
          ? `报价表 ${d.统计.报价表数} 个 · 型号 ${d.统计.型号数} 个 · 报价行 ${d.统计.报价行数} 行 · 图片 ${d.统计.图片数} 张\n`
          : '') +
        `上次整理：${d.生成时间 || '无'}；资料文件夹：${d.资料文件夹}\n` +
        `${d.提示}\n` +
        (d.型号示例?.length ? `型号示例：${d.型号示例.join('、')}\n` : '') +
        `清楚单：${d.清单路径}`,
    };
  }

  if (name === 'organize_library') {
    const r = await callGateway('/v1/library/organize', 'POST', { force: !!args.force });
    if (!r.ok) return failed(r);
    const d = r.data;
    return {
      text:
        `【资料库整理${d.ok ? '完成' : '没成功'}】\n${d.摘要}\n` +
        `用时 ${d.耗时毫秒} 毫秒；用户原始文件没有被改动、移动或删除。\n` +
        (d.新增文件?.length ? `新增：${d.新增文件.join('、')}\n` : '') +
        (d.变更文件?.length ? `更新：${d.变更文件.join('、')}\n` : '') +
        (d.建议?.length ? `整理建议：\n${d.建议.map((t) => '  - ' + t).join('\n')}\n` : '') +
        `中文清单：${d.清单路径}\n` +
        `整理完之后，问价、问款式就会按这些真实数据回答。` + SAFETY,
    };
  }

  if (name === 'search_library') {
    const q = new URLSearchParams({ keyword: String(args.keyword || ''), limit: String(args.limit || 8) });
    const r = await callGateway('/v1/library/search?' + q.toString());
    if (!r.ok) return failed(r);
    const d = r.data;
    return {
      text:
        (d.ok
          ? `【资料库检索：${args.keyword}】命中 ${d.data?.命中行数 ?? 0} 行\n${json(d.data)}`
          : `没找到「${args.keyword}」。${d.data?.hint || ''} 请不要编造价格或文件名。`) +
        `\n` + SAFETY,
    };
  }

  if (name === 'search_cases') {
    const q = new URLSearchParams();
    for (const k of ['country', 'product', 'q']) if (args[k]) q.set(k, args[k]);
    q.set('limit', '10');
    const r = await callGateway('/v1/cases?' + q.toString());
    if (!r.ok) return failed(r);
    const list = r.data.data || [];
    return {
      text:
        `找到 ${list.length} 条已入库的成功案例（只有审核通过的案例才能被引用）：\n` +
        (list.length ? json(list) : '没有匹配案例，请人工补充，不要虚构案例。') +
        `\n` + SAFETY,
    };
  }

  if (name === 'generate_reply') {
    const stage = args.stage || 'negotiate';
    const payload = {
      model: args.agent || 'auto',
      messages: [{ role: 'user', content: args.message }],
      stream: false,
      temperature: 0.4,
      context: {
        session_id: 's_workbuddy_' + Date.now(),
        customer: {
          country: args.country || 'MX',
          type: 'trader',
          stage,
          name: args.customer || 'there',
        },
        channel: 'workbuddy',
        locale: args.locale || 'es-MX',
        scenario: stage,
      },
    };
    const r = await callGateway('/v1/chat/completions', 'POST', payload);
    if (!r.ok) return failed(r);
    const draft = r.data.choices?.[0]?.message?.content || '（这次没有生成内容，请重试）';
    const m = r.data.x_meta || {};
    const traces = (m.tools_called || [])
      .map((t) => `${t.name}${t.ok ? '（命中）' : '（未命中）'}${t.file ? ` ${t.file} 第 ${t.row} 行` : ''}`)
      .join('；');
    return {
      text:
        `${draft.includes('【回复稿】') ? '' : '【回复稿】\n'}${draft}\n\n` +
        `【本次依据】由 ${AGENT_CN[m.agent] || m.agent || '内置助手'} 起草；查过的资料：${traces || '没有查资料'}；` +
        `用时 ${m.latency_ms ?? 0} 毫秒。\n` +
        `【核对要求】价格敏感：${m.price_sensitive ? '是' : '否'}；必须人工确认：${m.need_human_confirm ? '是' : '否'}。\n` +
        `【学习记录编号】${m.suggestion_id || '无'}（客户后来成交或没成，请用 mark_outcome 标记这条编号，话术才会越用越准）\n` +
        `【本次场景】${m.intent || 'general'}\n` +
        `完整留痕：${json(m)}\n` +
        SAFETY,
    };
  }

  /* ==================== 话术持续优化闭环 ==================== */

  if (name === 'check_workbuddy_link') {
    const r = await callGateway('/v1/workbuddy/status');
    if (!r.ok) return failed(r);
    const d = r.data;
    const lines = (d.checks || []).map((c) => `  ${c.ok ? '√' : '×'} ${c.name}`).join('\n');
    return {
      text:
        `【连接状态】${d.message}\n` +
        `【逐项检查】\n${lines}\n` +
        `【下一步】${d.hint}\n\n` +
        `重要：你能读到这段话，说明 WorkBuddy 已经成功连上这台电脑的客服回复助手 —— 这就是最直接的确认方式。\n` +
        `想再验证一次，可以说「查看资料库状态」，能返回已关联的型号数就是通的。\n` +
        SAFETY,
    };
  }

  if (name === 'list_history') {
    const q = new URLSearchParams({ limit: String(Math.min(Number(args.limit ?? 20), 100)) });
    if (args.label) q.set('label', args.label);
    const r = await callGateway('/v1/learning/records?' + q.toString());
    if (!r.ok) return failed(r);
    const rows = r.data.data || [];
    const s = r.data.stats || {};
    const text = rows.length
      ? rows.map((x, i) =>
          `${i + 1}. [${x.标记}] ${x.时间} · ${x.场景}\n` +
          `   编号：${x.id}\n   客户：${String(x.客户消息).slice(0, 90)}\n` +
          `   回复：${String(x.回复稿).slice(0, 110).replace(/\n/g, ' ')}\n` +
          (x.原因 ? `   备注：${x.原因}\n` : ''),
        ).join('\n')
      : '目前还没有记录。先在界面里生成几次回复稿，或导入成功案例。';
    return {
      text:
        `【学习记录】共 ${s.total ?? 0} 条；已标记 ${s.labeled ?? 0} 条（成功 ${s.success ?? 0}、失败 ${s.failure ?? 0}），成功率 ${s.success_rate != null ? (s.success_rate * 100).toFixed(1) + '%' : '—'}\n\n` +
        text +
        `\n\n用户说「这单成了 / 这封没回 / 客户嫌贵」时，用 mark_outcome 按编号标记；也可以让我根据这些记录分析原因。\n` +
        SAFETY,
    };
  }

  if (name === 'mark_outcome') {
    const label = String(args.outcome || '').toLowerCase() === 'failure' ? 'failure' : 'success';
    const body = { label, note: String(args.reason || '').trim() };
    if (args.record_id) body.id = String(args.record_id);
    else if (args.session_id) body.session_id = String(args.session_id);
    else return { text: '请给出 record_id（学习记录编号）或 session_id。可先用 list_history 查编号。', isError: true };
    const r = await callGateway('/v1/learning/mark', 'POST', body);
    if (!r.ok) return failed(r);
    return {
      text:
        `【已标记】${r.data.提示}（编号 ${r.data.id}）\n` +
        `【话术库已更新】${r.data.script_summary}\n` +
        `下一次生成回复稿时，这个场景会自动参考这次的经验；失败案例会从案例库撤出。\n` +
        `建议接着调用 review_scripts 看看还该改什么。\n` +
        SAFETY,
    };
  }

  if (name === 'review_scripts') {
    const [a, b] = await Promise.all([callGateway('/v1/scripts/review'), callGateway('/v1/learning/stats')]);
    if (!a.ok) return failed(a);
    return {
      text:
        `【话术库现状】\n${a.data.text}\n\n` +
        `【学习统计】${json(b.ok ? b.data : {})}\n\n` +
        `请你（WorkBuddy）做两件事：\n` +
        `1. 用中文指出哪类场景经验最少、哪类失败最多、话术该往哪个方向改，给出 2～5 条具体、可执行的建议；\n` +
        `2. 把建议用 save_script_advice 工具写回话术库，这样下次起草回复稿就会自动采用。\n` +
        `注意：建议只谈语气、结构、顺序和该问什么，绝不能写死价格、交期、账期等数字。\n` +
        SAFETY,
    };
  }

  if (name === 'optimize_scripts') {
    const r = await callGateway('/v1/scripts/rebuild', 'POST', {});
    if (!r.ok) return failed(r);
    return {
      text:
        `【话术库已重新归纳】${r.data.summary}\n` +
        `版本 ${r.data.version}；文件：${r.data.file}（可以用记事本直接改，改完自动生效）。\n` +
        `建议再调用 review_scripts 让 WorkBuddy 提出进一步优化建议并写回。\n` +
        SAFETY,
    };
  }

  if (name === 'save_script_advice') {
    const lines = Array.isArray(args.advice) ? args.advice : [args.advice];
    const clean = lines.map((x) => String(x ?? '').trim()).filter(Boolean);
    if (!clean.length) return { text: '没有收到任何建议内容。', isError: true };
    const r = await callGateway('/v1/scripts/advice', 'POST', { advice: clean, mode: args.mode === 'replace' ? 'replace' : 'append' });
    if (!r.ok) return failed(r);
    return {
      text:
        `【已写回话术库】${r.data.提示}（版本 ${r.data.version}，累计建议 ${r.data.count} 条）\n` +
        `这些建议会拼进系统提示词，所有 AI 下一次起草时都会遵守；你可以随时用「查看话术库」核对。\n` +
        SAFETY,
    };
  }

  if (name === 'import_success_case') {
    const body = {
      label: String(args.outcome || 'success').toLowerCase() === 'failure' ? 'failure' : 'success',
      customer_text: String(args.customer_text ?? ''),
      draft_text: String(args.draft_text ?? ''),
      note: String(args.note ?? ''),
      country: String(args.country ?? ''),
      product: String(args.product ?? ''),
    };
    const r = await callGateway('/v1/learning/import-case', 'POST', body);
    if (!r.ok) return failed(r);
    return {
      text:
        `【已入库】${r.data.提示}（编号 ${r.data.id}）\n${r.data.script_summary}\n` +
        `成功案例会同时进入案例库，AI 以后可以检索引用；失败案例只作为「不要这样写」的经验。\n` +
        SAFETY,
    };
  }

  return { text: `没有这个工具：${name}`, isError: true };
}

/** 工具描述全部用中文，WorkBuddy 看到你的中文问题就会自动选对工具 */
const TOOLS = [
  {
    name: 'gateway_status',
    title: '查看客服助手状态',
    description: '查看后台服务是否在运行、有几个 AI 可用、资料文件夹是否就绪。不确定程序有没有启动时先调这个。',
    shape: {},
    readOnly: true,
  },
  {
    name: 'lookup_quote',
    title: '查报价表',
    description: '按产品型号从本机真实报价表里查价格、起订量、交期、生效日期，并返回来源文件与行号。客户问价格、报价、多少钱时必须先调这个，禁止自己编价格。',
    shape: { sku: z.string().min(1).describe('产品型号或产品名') },
    readOnly: true,
  },
  {
    name: 'find_files',
    title: '找产品图和证书',
    description: '按型号或关键词在本机资料文件夹里找产品图片、报价表、证书等真实文件，返回文件路径。找不到就如实说，不要编造文件名。',
    shape: {
      keyword: z.string().min(1).describe('型号或关键词'),
      kind: z.enum(['image', 'quote', 'cert', 'case']).optional().describe('资料类型：图片 / 报价 / 证书 / 案例，可不填'),
    },
    readOnly: true,
  },
  {
    name: 'library_status',
    title: '查看资料库有没有关联上',
    description: '查看本机客服资料库是否已整理、认出多少型号和报价行、上次整理时间、有没有新增文件需要重新整理。用户问「我的报价表连上了吗 / 为什么查不到」时先调这个。',
    shape: {},
    readOnly: true,
  },
  {
    name: 'organize_library',
    title: '整理我的客服资料库',
    description: '用户说「整理资料库 / 把报价表关联起来 / 我加了新文件 / 定时整理资料」时调用。扫描资料文件夹里的报价表、图片、证书，识别中文表头和合并单元格，生成可检索索引；几百 MB 的图文报价表也只读其中文字部分。全程只读，不改名、不移动、不删除原文件。整理完成后请用中文简报汇报认出多少型号、有没有未识别文件、以及整理建议。',
    shape: {
      force: z.boolean().optional().describe('一般不用填；改过表头或怀疑读错时填 true 强制全部重读'),
    },
    readOnly: false,
  },
  {
    name: 'search_library',
    title: '按产品名或关键词检索资料库',
    description: '客户没给精确型号、问「有没有皮壳 / Cover 系列多少钱 / 某系列产品」时用这个，按型号、产品名、系列、规格检索真实价格、货期和来源行号。查不到就如实说，不要编价格。',
    shape: {
      keyword: z.string().min(1).describe('型号、产品名、系列或关键词'),
      limit: z.number().optional().describe('最多返回几条，默认 8'),
    },
    readOnly: true,
  },
  {
    name: 'search_cases',
    title: '查成功案例',
    description: '查已入库、审核过的成功案例和可复用话术。可按国家、产品、关键词筛选。只有入库案例才能引用。',
    shape: {
      country: z.string().optional().describe('国家代码，例如 MX'),
      product: z.string().optional().describe('产品型号或产品名'),
      q: z.string().optional().describe('关键词'),
    },
    readOnly: true,
  },
  {
    name: 'generate_reply',
    title: '生成客服回复稿',
    description: '把客户消息交给本机客服助手，自动查报价表 / 资料 / 案例后生成外文回复稿和中文说明，并返回价格来源与是否需要人工确认。只生成草稿，绝不自动发送。',
    shape: {
      message: z.string().min(1).describe('客户发来的原始消息，原样粘贴'),
      stage: z.enum(['promote', 'negotiate', 'followup', 'complex_quote', 'draft_only']).optional().describe('客户阶段：开发 / 议价 / 跟进 / 复杂报价 / 只起草'),
      country: z.string().optional().describe('国家代码，默认 MX'),
      customer: z.string().optional().describe('客户称呼'),
      locale: z.string().optional().describe('回复语种，默认 es-MX（墨西哥西班牙语）'),
      agent: z.string().optional().describe('指定某个 AI；不填则自动选择'),
    },
    readOnly: false,
  },
  {
    name: 'check_workbuddy_link',
    title: '检查是否已连上 WorkBuddy',
    description: '当用户问「连上了吗 / 怎么确认连接 / WorkBuddy 能不能用」时调用。逐项检查连接器登记、信任记录、工具加载情况，并用中文给出结论和下一步。能读到这个工具返回的内容，本身就说明已经连上了。',
    shape: {},
    readOnly: true,
  },
  {
    name: 'list_history',
    title: '查看聊天记录与学习样本',
    description: '列出使用程序产生的每次回复稿（客户消息、回复内容、是否已标记成功/失败、编号）。用户想复盘、想标记某次结果、想看学到多少案例时用这个。可按 success / failure / unlabeled 筛选。',
    shape: {
      label: z.enum(['success', 'failure', 'unlabeled']).optional().describe('只看成功 / 只看失败 / 只看还没标记的'),
      limit: z.number().optional().describe('最多看几条，默认 20'),
    },
    readOnly: true,
  },
  {
    name: 'mark_outcome',
    title: '标记这次回复是成功还是失败',
    description: '当用户说「这单成了 / 客户下单了 / 这封没回 / 客户嫌贵 / 标记失败」时调用。按学习记录编号（先用 list_history 查）或会话编号标记成功或失败，并写清楚原因。标记后会自动写进或撤出案例库，并立刻重新归纳话术库。',
    shape: {
      record_id: z.string().optional().describe('学习记录编号，例如 lr_xxxxxxxx；可从 list_history 或 generate_reply 的结果里拿到'),
      session_id: z.string().optional().describe('不知道编号时可用会话编号，自动标记该会话最近一次回复'),
      outcome: z.enum(['success', 'failure']).describe('success=成交/客户满意；failure=没成/客户不满'),
      reason: z.string().optional().describe('中文原因，例如「客户接受了报价」「报价太高没回」；这条会变成话术经验'),
    },
    readOnly: false,
  },
  {
    name: 'review_scripts',
    title: '审阅话术库并提出优化建议',
    description: '当用户说「帮我优化话术 / 话术还能怎么改 / 根据成功案例分析一下」时先调用这个。返回各场景的成功/失败数量、已验证话术与经验教训。读完后你必须再用 save_script_advice 把具体建议写回话术库，否则优化不会生效。',
    shape: {},
    readOnly: true,
  },
  {
    name: 'optimize_scripts',
    title: '重新归纳话术库',
    description: '把所有已标记的成功案例和失败案例重新归纳成话术库（版本 +1）。导入新案例、标记新结果后自动执行过；用户明确说「重新学习 / 重建话术库」时再手动调一次。',
    shape: {},
    readOnly: false,
  },
  {
    name: 'save_script_advice',
    title: '把优化建议写回话术库',
    description: '把 WorkBuddy 分析出的具体话术建议持久化保存，之后所有 AI 起草回复稿时都会自动遵守。建议只谈语气、结构、顺序、该问什么，不要写死价格、交期、账期等数字。',
    shape: {
      advice: z.array(z.string().min(1)).describe('2～5 条中文建议，每条一句话，具体可执行'),
      mode: z.enum(['append', 'replace']).optional().describe('append=追加（默认）；replace=清空旧建议只保留本次'),
    },
    readOnly: false,
  },
  {
    name: 'import_success_case',
    title: '整理并导入一段成功或失败对话',
    description: '用户给你一段真实对话（客户消息 + 你发出去的回复）并说「这个记成成功案例 / 这个是失败教训」时调用。会自动识别场景、写进学习记录与案例库，并重新归纳话术。',
    shape: {
      customer_text: z.string().min(1).describe('客户当时发的原话'),
      draft_text: z.string().min(1).describe('最终发出去的回复内容或可复用话术'),
      outcome: z.enum(['success', 'failure']).optional().describe('默认 success'),
      note: z.string().optional().describe('为什么成功 / 为什么失败，中文'),
      country: z.string().optional().describe('国家代码，例如 MX'),
      product: z.string().optional().describe('产品型号或产品名'),
    },
    readOnly: false,
  },
  {
    name: 'image_match_quote',
    title: '按客户图片查报价',
    description: '客户发来产品图片、让你「看图报价 / 这多少钱 / 这款有没有」时调用。把图片或本机图片路径与当前库存表 / 报价表里的产品图做本地指纹比对，返回最像的型号、出厂价、货期与来源文件/工作表/行号。需要先建图片索引（在客服助手界面「加图片」按钮上悬停可重建，库存表更新后要重建一次）。绝不猜价格。',
    shape: {
      image: z.string().optional().describe('客户图片的 base64 或 dataURL；和 image_path 二选一'),
      image_path: z.string().optional().describe('本机图片完整路径，例如 C:\\Users\\me\\Desktop\\客户发来的图.jpg'),
      limit: z.number().optional().describe('最多返回几个候选，默认 5'),
    },
    readOnly: true,
  },
];

export function createServer() {
  const server = new McpServer({ name: 'trade-cs-ai', version: '0.1.0' });
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.shape,
        annotations: { readOnlyHint: t.readOnly },
      },
      async (args) => {
        const r = await runTool(t.name, args || {});
        return {
          content: [{ type: 'text', text: r.text }],
          ...(r.isError ? { isError: true } : {}),
        };
      },
    );
  }
  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error('客服回复助手已连接 WorkBuddy：查报价 / 找资料 / 生成回复稿 / 标记成败 / 优化话术（不自动发送）');
}

// 只有被 WorkBuddy 作为独立进程启动时才连接；被 import 时只导出函数，方便自检。
const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((e) => {
    console.error('连接 WorkBuddy 失败：', e);
    process.exit(1);
  });
}
