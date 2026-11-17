/**
 * 话术库：把「成功案例 / 失败案例」变成下次起草时能用的经验。
 *
 * 数据来源只有两类：
 *   ① 你导入的成功案例（自动记为成功样本）
 *   ② 使用程序产生的聊天记录里，你亲手标记的成功 / 失败
 *
 * 产物是 data/话术库.json —— 一个纯中文 JSON，可以用记事本直接改。
 * 改完不用重启，下一次生成回复稿时自动生效（按文件修改时间热加载）。
 *
 * 安全底线：历史回复里的价格、日期等数字一律替换成占位符，
 * 绝不把旧价格当成经验塞给 AI；每次报价仍必须查当前报价表。
 */
import fs from 'node:fs';
import path from 'node:path';
import { cleanDraftText } from '@trade-cs-ai/core';
import { cfg } from '../config.js';
import { ALL_INTENT_KEYS, intentInfo } from './intents.js';
import { labeledSamples, learningStats, type LearningRecord } from '../store/sqlite.js';

export interface SceneScript {
  '场景名': string;
  '默认要点': string;
  '成功话术': string[];
  '避免': string[];
  '经验教训': string[];
  '成功数': number;
  '失败数': number;
}

export interface ScriptBook {
  '说明': string;
  '更新时间': string;
  '版本': number;
  '统计': { '总记录': number; '已标记': number; '成功': number; '失败': number; '成功率': string };
  '场景': Record<string, SceneScript>;
  '总体偏好': string[];
  '总体禁忌': string[];
  'WorkBuddy建议': string[];
}

const FILE = path.join(cfg.root, 'data', '话术库.json');
const INTRO =
  '这个文件可以用记事本直接改：改完保存即可，不用重启程序。' +
  '「成功话术」是成交案例里被验证有效的说法；「避免」是三份没成交复盘与失败案例暴露的问题；' +
  '「WorkBuddy建议」是从四份真实客服聊天记录（一份成交、三份没成交）提炼、由 WorkBuddy 写回来的做法。' +
  '客户向我们要型号清单就给当前库存表真实清单，给不出就说会确认并给时间点；报价一次讲清含不含包装、卡纸、logo 等附加项加不加钱；' +
  '客户给了目标价 / 数量 / 别家报价先接住条件，不质问、不施压；客户点名要样品并给了地址 / 唛头就逐款标价并确认寄样。' +
  '价格、数量、交期一律以当前报价表 / 库存表为准，历史数字不会被复用；' +
  '库存与产品图会随实际库存表随时变化，当前库存表尚未更新，查不到在中文说明里写「待人工补充」，客户正文用自然的人话说「我再确认一下」。' +
  '回复稿要像人在聊天软件里手打的短句，不要邮件、机翻或 AI 模板腔。';

export function scriptFilePath(): string {
  return FILE;
}

export function defaultScriptBook(): ScriptBook {
  const scenes: Record<string, SceneScript> = {};
  for (const key of ALL_INTENT_KEYS) {
    const info = intentInfo(key);
    scenes[key] = {
      '场景名': info.label,
      '默认要点': info.hint,
      '成功话术': [],
      '避免': [],
      '经验教训': [],
      '成功数': 0,
      '失败数': 0,
    };
  }
  return {
    '说明': INTRO,
    '更新时间': new Date().toISOString(),
    '版本': 1,
    '统计': { '总记录': 0, '已标记': 0, '成功': 0, '失败': 0, '成功率': '—' },
    '场景': scenes,
    '总体偏好': [
      '先回答客户真正问的那件事；一句一件事、短句分行，像微信里手打，不用邮件开头 / 落款 / 客套',
      '报价一次说清含不含包装、对应哪一批和哪个型号清单，同一会话同一款口径一致',
      '客户说贵时先反问目标价，再决定让不让；每次只让一小步，并说明这已是最低价',
      '请客户做型号清单 / 发票前先锁价；客户问质量给能核查的实拍或视频，别只回形容词',
      '库存数量、型号、产品图以当前库存表为准，未更新在中文说明写「待人工补充」；谈到底线就转确认数量 / 付款 / 装箱单',
      '先答客户问的那件事；客户要型号清单就给真实清单，给不出就说会确认并给时间点，别用混款混色 / 亏本清仓搪塞',
      '客户给了目标价 / 数量 / 别家报价先接住条件，不质问、不连说 impossible；客户点名要样品并给了地址 / 唛头就逐款标价并确认寄样',
    ],
    '总体禁忌': [
      '不要照抄历史价格、数量、交期、账期等数字；所有数字必须来自本次工具返回的当前表',
      '不要前后报两个价还否认自己说过的话，不要让客户先做清单再改价，不要记反客户说过的规格',
      '不要把案例聊天里的库存照片、视频、表格文件、装箱单、收款码当成现在可发的资料',
      '不要编造亏损金额、新订单价、其他客户在等、文件名、客户名或仓库地址；不要反复哭穷施压',
      '不要写 Dear / 感谢您的咨询 / Please note that / Best regards 等模板句，不要编号列表、加粗、三段式和客套排比',
      '不要在客户正文里出现中文、内部占位符「待人工补充」、资料来源或出厂价字样',
      '不要客户没砍就自己连续降价还每次换数量档 / 包装，不要等客户问才说不含包装、补完又涨价，不要事后才说印 logo 加钱',
      '不要一个月反复发 Hi boss / Do you need? / 催清单，客户说忙还照催；不要断联很久只甩一个没有上下文的降价数字',
    ],
    'WorkBuddy建议': [],
  };
}

/** 只取回复稿正文（中文翻译和注解都不能学进话术库），并把历史数字替换成占位符 */
function extractScript(text: string, maxLen = 260): string {
  let s = cleanDraftText(text);
  s = s
    .replace(/(USD\s?|US\$|\$|¥|RMB\s?)\s?\d[\d.,]*/gi, '〔价格以当前报价表为准〕')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '〔日期以当前资料为准〕')
    .replace(/\b\d+\s*(days?|天|周|weeks?)\b/gi, '〔交期以当前报价表为准〕')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

function unique(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const s = String(raw ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/** 重新归纳：读所有已标记样本 → 按场景分组 → 写回话术库文件 */
export function rebuildScriptBook(): { book: ScriptBook; summary: string } {
  const previous = loadScriptBook();
  const book = defaultScriptBook();
  book['版本'] = Number(previous['版本'] ?? 0) + 1;
  // 说明里写着本版经验的来源与红线，是人工写进去的，不能被默认文案覆盖
  book['说明'] = previous['说明'] || INTRO;
  book['总体偏好'] = [...previous['总体偏好']];
  book['总体禁忌'] = [...previous['总体禁忌']];
  book['WorkBuddy建议'] = [...previous['WorkBuddy建议']];

  const samples = labeledSamples();
  for (const key of ALL_INTENT_KEYS) {
    const scene = book['场景'][key];
    const rows = samples.filter((r: LearningRecord) => (r.intent || 'greeting') === key);
    const successes = rows.filter((r) => r.label === 'success');
    const failures = rows.filter((r) => r.label === 'failure');
    scene['成功数'] = successes.length;
    scene['失败数'] = failures.length;
    const prevScene = previous['场景']?.[key];
    // 人工从真实成功案例沉淀的经验是「基线」，永远排在最前面：
    // 客服后来标记的一两条样本只追加在后面，绝不能把案例经验整个替换掉。
    // 以前有样本就覆盖，点一次「记成功」就把案例沉淀的经验清空了。
    const baseSucc = prevScene?.['成功话术'] ?? [];
    const baseAvoid = prevScene?.['避免'] ?? [];
    const baseLessons = prevScene?.['经验教训'] ?? [];
    scene['成功话术'] = unique(
      [...baseSucc, ...successes.map((r) => extractScript(r.draft_text || r.note || ''))],
      Math.max(5, baseSucc.length + 2),
    );
    scene['避免'] = unique(
      [...baseAvoid, ...failures.map((r) => extractScript(r.draft_text || '', 140))],
      Math.max(3, baseAvoid.length + 1),
    );
    scene['经验教训'] = unique(
      [...baseLessons, ...failures.map((r) => (r.note || '').trim()), ...successes.map((r) => (r.note || '').trim())],
      Math.max(5, baseLessons.length + 2),
    );
  }

  const stats = learningStats();
  book['统计'] = {
    '总记录': Number(stats.total ?? 0),
    '已标记': Number(stats.labeled ?? 0),
    '成功': Number(stats.success ?? 0),
    '失败': Number(stats.failure ?? 0),
    '成功率': Number(stats.labeled ?? 0)
      ? `${(Number(stats.success_rate ?? 0) * 100).toFixed(1)}%`
      : '—',
  };
  book['更新时间'] = new Date().toISOString();
  writeScriptBook(book);

  const learned = ALL_INTENT_KEYS.filter((k) => book['场景'][k]['成功数'] + book['场景'][k]['失败数'] > 0);
  const summary =
    `已根据 ${samples.length} 条标记样本重新归纳话术库（版本 ${book['版本']}）。` +
    `成功 ${book['统计']['成功']} 条、失败 ${book['统计']['失败']} 条，成功率 ${book['统计']['成功率']}。` +
    (learned.length
      ? `已学到经验的场景：${learned.map((k) => book['场景'][k]['场景名']).join('、')}。`
      : '目前还没有标记样本，话术库只有内置基线建议。') +
    '下一次生成回复稿时会自动参考；历史价格数字不会被复用。';
  return { book, summary };
}

/** 写入 WorkBuddy（或你自己在记事本里）给出的优化建议 */
export function saveAdvice(lines: string[], mode: 'append' | 'replace' = 'append'): ScriptBook {
  const book = loadScriptBook();
  const clean = unique(lines.map((s) => String(s ?? '').trim()), 40);
  book['WorkBuddy建议'] = mode === 'replace' ? clean : unique([...book['WorkBuddy建议'], ...clean], 40);
  book['更新时间'] = new Date().toISOString();
  book['版本'] = Number(book['版本'] ?? 0) + 1;
  writeScriptBook(book);
  return book;
}

export function writeScriptBook(book: ScriptBook): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(book, null, 2) + '\n', 'utf8');
  cached = undefined;
}

let cached: { mtime: number; book: ScriptBook } | undefined;

/** 热加载：文件一改（包括你用记事本手改），下一次请求就生效 */
export function loadScriptBook(): ScriptBook {
  try {
    if (!fs.existsSync(FILE)) {
      const book = defaultScriptBook();
      writeScriptBook(book);
      return book;
    }
    const mtime = fs.statSync(FILE).mtimeMs;
    if (cached && cached.mtime === mtime) return cached.book;
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<ScriptBook>;
    const base = defaultScriptBook();
    const book: ScriptBook = {
      ...base,
      ...parsed,
      '统计': { ...base['统计'], ...(parsed['统计'] ?? {}) },
      '场景': { ...base['场景'], ...(parsed['场景'] ?? {}) },
      '总体偏好': Array.isArray(parsed['总体偏好']) ? parsed['总体偏好'] : base['总体偏好'],
      '总体禁忌': Array.isArray(parsed['总体禁忌']) ? parsed['总体禁忌'] : base['总体禁忌'],
      'WorkBuddy建议': Array.isArray(parsed['WorkBuddy建议']) ? parsed['WorkBuddy建议'] : [],
    };
    cached = { mtime, book };
    return book;
  } catch {
    return defaultScriptBook();
  }
}

/** 注入系统提示词的一段中文：控制条数与每条长度，避免把提示词撑爆 */
function clampLines(items: string[], max: number, perLine = 220): string[] {
  return items.slice(0, max).map((x) => String(x ?? '').slice(0, perLine));
}

export function scriptPromptExtra(intent?: string): string {
  const book = loadScriptBook();
  const keys = ALL_INTENT_KEYS.filter((k) => {
    const s = book['场景'][k];
    return s && (s['成功数'] + s['失败数'] > 0 || s['成功话术'].length || s['避免'].length);
  });
  const chunks: string[] = [];
  const ordered = intent ? [intent, ...keys.filter((k) => k !== intent)] : keys;
  for (const key of ordered.slice(0, 9)) {
    const s = book['场景'][key];
    if (!s) continue;
    const parts: string[] = [`· ${s['场景名']}：${s['默认要点']}`];
    if (s['成功话术'].length) parts.push(`  已验证有效的写法：${s['成功话术'].slice(0, 2).map((x) => `「${x.slice(0, 80)}」`).join('；')}`);
    if (s['避免'].length) parts.push(`  避免这样写：${s['避免'].slice(0, 2).map((x) => `「${x.slice(0, 75)}」`).join('；')}`);
    if (s['经验教训'].length) parts.push(`  经验：${s['经验教训'].slice(0, 2).map((x) => x.slice(0, 95)).join('；')}`);
    chunks.push(parts.join('\n'));
  }
  // 人工从成交案例与谈崩复盘沉淀的经验放在「总体偏好 / 总体禁忌 / WorkBuddy建议」，
  // rebuildScriptBook() 会原样保留这三处，因此不会被重新归纳冲掉。
  // 以前只注入前 3 / 3 / 6 条，案例经验一多就被截掉，这里放宽并做长度封顶。
  const advice = clampLines(book['WorkBuddy建议'], 18);
  return [
    '',
    '【话术经验库（来自真实成交案例与谈崩复盘，只学写法、语气与节奏；客户正文要像真人手打，不要 AI / 邮件模板腔）】',
    ...clampLines(book['总体偏好'], 8).map((x) => `· ${x}`),
    ...clampLines(book['总体禁忌'], 8).map((x) => `· 禁止：${x}`),
    ...chunks,
    ...(advice.length ? ['【从真实客服聊天记录提炼的做法】', ...advice.map((x) => `· ${x}`)] : []),
    '注意：经验来自四份真实记录（一份成交、三份没成交的复盘），只学写法、语气与节奏，别把没成交的话术当成功经验。经验里的价格、数量、交期、日期都只是写法示例或占位符，实际数字必须来自本次工具返回的当前报价表 / 库存表；库存与产品图会随时变化，且当前库存表尚未更新。客户要清单 / 图 + 价就一起给，只发当前库存表确有的货。查不到时在【中文说明】写「待人工补充」，【回复稿】正文用自然的人话说「我再确认一下」，不要把内部占位符写给客户。',
  ].join('\n');
}

/** 给 WorkBuddy 看的中文摘要：让它据此提出改进建议 */
export function scriptReviewText(): string {
  const book = loadScriptBook();
  const stats = book['统计'];
  const lines = [
    `话术库版本 ${book['版本']}，最后更新 ${book['更新时间']}。`,
    `学习记录共 ${stats['总记录']} 条，已标记 ${stats['已标记']} 条：成功 ${stats['成功']}、失败 ${stats['失败']}，成功率 ${stats['成功率']}。`,
    '',
    '各场景现有经验：',
  ];
  for (const key of ALL_INTENT_KEYS) {
    const s = book['场景'][key];
    if (!s) continue;
    lines.push(
      `- ${s['场景名']}（成功 ${s['成功数']} / 失败 ${s['失败数']}）：` +
      `成功话术 ${s['成功话术'].length} 条；避免 ${s['避免'].length} 条；经验 ${s['经验教训'].length} 条。`,
    );
    if (s['经验教训'].length) lines.push(`  经验：${s['经验教训'].join('；')}`);
  }
  if (book['WorkBuddy建议'].length) lines.push('', '已有优化建议：' + book['WorkBuddy建议'].join('；'));
  return lines.join('\n');
}
