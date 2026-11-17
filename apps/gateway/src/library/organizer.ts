import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config.js';
import { readXlsTextWithRows, readXlsxTextWithRows } from './xlsxText.js';
import { countEmbeddedImages } from './zipReader.js';

/**
 * 客服资料库整理器
 *
 * 目标：用户把报价表 / 图片 / 证书直接丢进「data/客服资料库」，不用按任何格式改名，
 * 程序自动扫描、识别表头、把「型号 → 价格 / 货期 / 来源行号」整理成一份轻量索引。
 * 之后 AI 查价走索引（毫秒级），不会再试图把 400MB 的图文报价表整个读进内存。
 *
 * 三条红线：
 *   ① 全程只读用户的原始资料，绝不改名、移动、删除或覆盖；
 *   ② 只在 data/ 目录下写索引、缓存和一份人能看懂的中文清单；
 *   ③ 识别不到就如实写进「建议」，绝不猜价格、绝不编文件名。
 */

const INDEX_FILE = path.join(cfg.root, 'data', '资料索引.json');
const CACHE_FILE = path.join(cfg.root, 'data', '资料索引.缓存.json');
const LIST_FILE = path.join(cfg.root, 'data', '资料清单.md');
const INDEX_VERSION = 2;

export interface QuoteRow {
  型号: string;
  名称: string;
  规格: string;
  材质: string;
  价格: number | null;
  价格原文: string;
  附加价格: string;
  币种: string;
  货期: string;
  MOQ: string;
  系列: string;
  备注: string;
  识别方式: '标准表头' | '宽松识别';
  关键词: string;
  文件: string;
  工作表: string;
  行号: number;
}

export interface IndexedFile {
  路径: string;
  类型: string;
  大小: number;
  修改时间: string;
  识别状态: string;
  提取行数: number;
  工作表数: number;
  内嵌图片: number;
  说明: string;
}

export interface ModelEntry {
  型号: string;
  出现次数: number;
  价格范围: string;
  币种: string;
  系列: string;
  示例名称: string;
  来源文件: string;
}

export interface LibraryIndex {
  版本: number;
  生成时间: string;
  资料文件夹: string;
  统计: {
    文件数: number;
    报价表数: number;
    图片数: number;
    文档数: number;
    报价行数: number;
    型号数: number;
    内嵌图片: number;
    未识别文件: number;
  };
  文件: IndexedFile[];
  报价: QuoteRow[];
  型号目录: ModelEntry[];
  建议: string[];
}

export interface OrganizeResult {
  ok: boolean;
  摘要: string;
  生成时间: string;
  耗时毫秒: number;
  统计: LibraryIndex['统计'];
  新增文件: string[];
  变更文件: string[];
  建议: string[];
  索引路径: string;
  清单路径: string;
}

/** 表头别名：覆盖外贸常规表、库存表、以及用户自己改过的中文列名 */
const ALIASES: Record<string, string[]> = {
  sku: ['型号', '款号', '产品型号', '货号', '编号', '款型', '品号', 'sku', 'model', 'itemno', 'partno', 'item', 'code'],
  price: ['出厂价', '价格', '单价', '报价', '售价', '批发价', '含税价', '经销价', '零售价', '金额', 'price', 'unitprice', 'fob'],
  name: ['品名', '名称', '产品名称', '分体名称', '款式', 'name', 'description', 'product'],
  spec: ['规格', '尺寸', '外径', '床垫规格', 'size', 'spec', 'dimension'],
  material: ['材质', '工艺', '面料', 'material', 'fabric'],
  lead: ['货期', '交期', '工期', '交货期', '发货', 'lead', 'delivery'],
  moq: ['起订量', '最小起订', 'moq'],
  currency: ['币种', '货币', 'currency'],
  unit: ['单位', 'unit'],
  note: ['备注', '说明', 'note', 'remark'],
};

const TABLE_EXT = /\.(xlsx|xlsm|xls|csv|tsv)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const DOC_EXT = /\.(pdf|docx?|txt|md|pptx?)$/i;

function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[\s_\-()（）【】\/\\]/g, '');
}

/** 找某一类列；同类有多列时取表头最短的（避免「13元/尺接触面真皮出厂价」压过「出厂价」） */
function findCols(header: string[], key: string): number[] {
  const hits: Array<{ i: number; len: number }> = [];
  header.forEach((h, i) => {
    const n = norm(h);
    if (!n) return;
    let hit = ALIASES[key].some((a) => n.includes(norm(a)));
    // 工厂报价表常见「真皮价 1.8/1.5」「布艺价 1.8/1.5」这类带规格后缀的列名，
    // 别名表里列不全，这里补一条只看中文「…价」结尾的宽松规则。
    if (!hit && key === 'price') {
      const bare = String(h).replace(/[\s\d.·、,，/\\()（）*]/g, '');
      if (/价$/.test(bare) && bare.length <= 14) hit = true;
    }
    if (hit) hits.push({ i, len: n.length });
  });
  return hits.sort((a, b) => a.len - b.len || a.i - b.i).map((h) => h.i);
}

function numbersIn(s: string): number[] {
  const out: number[] = [];
  for (const m of String(s ?? '').matchAll(/\d+(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

/**
 * 阶梯价 / 多档价不能自动取其中某一个数字当单价。
 * 例如「5千内-0.9元 / 5千起-0.8元 / 1万起-0.7元 / 可自选型号 +0.5元」，
 * 直接取第一个数字会得到「5 元」，是完全错误的报价。
 * 这类单元格保留原文、价格留空，中文说明里提示人工核对。
 */
function isTieredPrice(raw: string): boolean {
  const s = String(raw ?? '');
  const nums = (s.match(/\d+(?:\.\d+)?/g) ?? []).length;
  return nums >= 3 && /(起|以上|以内|内-|阶梯|千|万|自选|\+)/.test(s);
}

function clean(s: unknown): string {
  return String(s ?? '').replace(/\s*\n\s*/g, ' / ').replace(/\s{2,}/g, ' ').trim().slice(0, 160);
}

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > 6 || out.length > 5000) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('~$') || e.name.startsWith('.') || ['node_modules', '.git', '.workbuddy'].includes(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, depth + 1, out);
    else if (e.isFile()) out.push(abs);
  }
}

function fileType(name: string): string {
  if (TABLE_EXT.test(name)) return '报价表';
  if (IMAGE_EXT.test(name)) return '图片';
  if (DOC_EXT.test(name)) return '文档 / 证书';
  return '其他';
}

function readCsvRows(file: string): Array<{ name: string; rows: Array<{ row: number; cells: string[] }> }> {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const sep = /\t/.test(text.split(/\r?\n/)[0] ?? '') ? '\t' : ',';
  const rows = text.split(/\r?\n/).map((line, i) => ({ row: i + 1, cells: line.split(sep).map((c) => c.trim().replace(/^"|"$/g, '')) }));
  return [{ name: path.basename(file, path.extname(file)), rows }];
}

/**
 * 宽松识别：有些工厂款式表没有表头，一张纸排两栏（型号 / 材质 / 尺寸 / 价格 / 货期），
 * 例如「圆凳.长凳系列」。这类表找不到「型号+价格」表头，但仍能把带编码的型号捞出来，
 * 并把同一行右侧第一个纯数字当作价格。结果会明确标注「宽松识别」，提醒人工核对原表，
 * 绝不把猜出来的数字当正式报价。
 */
function extractLooseSheet(
  sheet: { name: string; rows: Array<{ row: number; cells: string[] }> },
  fileName: string,
): QuoteRow[] {
  const out: QuoteRow[] = [];
  const isModel = (s: string): boolean =>
    /^[A-Za-z]{1,6}[-]?\d{2,6}#?/.test(s) || (/[A-Za-z]{2}\d{2,}#?$/.test(s) && s.length <= 24);
  const isPrice = (s: string): boolean => /^\d{3,6}(?:\.\d{1,2})?$/.test(s) && Number(s) >= 100;
  const isLead = (s: string): boolean => /^\d+\s*[-~]\s*\d+\s*天?$/.test(s) || /^\d+\s*天$/.test(s);

  for (const r of sheet.rows) {
    const c = r.cells;
    const modelCols: number[] = [];
    c.forEach((v, i) => {
      const s = clean(v);
      if (s && modelCols.length < 6 && isModel(s)) modelCols.push(i);
    });
    if (!modelCols.length) continue;
    for (let k = 0; k < modelCols.length; k++) {
      const from = modelCols[k];
      const to = k + 1 < modelCols.length ? modelCols[k + 1] : c.length;
      let price: number | null = null;
      let priceRaw = '';
      let spec = '';
      let lead = '';
      for (let i = from + 1; i < to && i < c.length; i++) {
        const s = clean(c[i]);
        if (!s) continue;
        if (isPrice(s) && price === null) { price = Number(s); priceRaw = s; continue; }
        if (isLead(s)) { lead = s; continue; }
        if (!spec && !/^\d+([*x×]\d+)+/.test(s)) spec = s;
      }
      if (price === null && !spec) continue;
      const model = clean(c[from]);
      out.push({
        型号: model, 名称: '', 规格: spec, 材质: '',
        价格: price, 价格原文: priceRaw, 附加价格: '', 币种: 'CNY',
        货期: lead, MOQ: '', 系列: sheet.name,
        备注: '原表没有标准表头，这是按行推测的，请打开原文件核对这一行',
        识别方式: '宽松识别',
        关键词: [model, spec, sheet.name].filter(Boolean).join(' ').toLowerCase(),
        文件: fileName, 工作表: sheet.name, 行号: r.row,
      });
    }
  }
  return out;
}

/** 从一张工作表里抽出所有报价行 */
function extractSheet(
  sheet: { name: string; rows: Array<{ row: number; cells: string[] }> },
  fileName: string,
  fileCurrency: string,
  /** .xls 库存表的型号列常是单元格图片，解析后为空；允许逐行用「产品类型 / 名称」列代替 */
  skuFallback = false,
): QuoteRow[] {
  const rows = sheet.rows;
  let headerIdx = -1;
  let skuCol = -1;
  let priceCol = -1;
  let otherPriceCols: number[] = [];
  let cols: Record<string, number> = {};

  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const sku = findCols(rows[i].cells, 'sku');
    const price = findCols(rows[i].cells, 'price');
    if (sku.length && price.length) {
      headerIdx = i;
      skuCol = sku[0];
      priceCol = price[0];
      otherPriceCols = price.slice(1, 4);
      cols = Object.fromEntries(
        Object.keys(ALIASES).filter((k) => !['sku', 'price'].includes(k)).map((k) => [k, findCols(rows[i].cells, k)[0] ?? -1]),
      ) as Record<string, number>;
      break;
    }
  }
  if (headerIdx < 0 || skuCol < 0 || priceCol < 0) return extractLooseSheet(sheet, fileName);

  const header = rows[headerIdx].cells;
  const series =
    sheet.name && !/^sheet\d+$/i.test(sheet.name)
      ? sheet.name
      : clean(rows.slice(0, headerIdx).reverse().find((r) => r.cells.some((c) => c && c.length > 3))?.cells.find(Boolean) ?? '');

  const out: QuoteRow[] = [];
  let currentSku = '';
  let currentMaterial = '';
  let currentLead = '';
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const c = r.cells;
    // WPS 库存表的型号列常是单元格图片（=DISPIMG），解析后为空。
    // 逐行回退到「产品类型 / 名称」列当检索词，绝不编型号；备注里提醒按行号核对原表。
    let skuCell = clean(c[skuCol]);
    const usedNameAsSku = skuFallback && !skuCell && cols.name >= 0 && Boolean(clean(c[cols.name]));
    if (usedNameAsSku) skuCell = clean(c[cols.name]);
    // 合并单元格：型号只在第一款写一次，下面空白行属于同一型号的不同规格
    if (skuCell) {
      // 表里可能有重复的表头行 / 小计行，别把它们当成产品型号
      if (/^(合计|总计|小计|备注|说明)$/.test(skuCell) || norm(skuCell) === norm(header[skuCol])) {
        currentSku = '';
        continue;
      }
      currentSku = skuCell;
      currentMaterial = '';
      currentLead = '';
    }
    if (!currentSku) continue;
    const priceRaw = clean(c[priceCol]);
    const spec = cols.spec >= 0 ? clean(c[cols.spec]) : '';
    const name = cols.name >= 0 ? clean(c[cols.name]) : '';
    const material = cols.material >= 0 ? clean(c[cols.material]) : '';
    const lead = cols.lead >= 0 ? clean(c[cols.lead]) : '';
    if (material) currentMaterial = material;
    if (lead) currentLead = lead;
    const tiered = isTieredPrice(priceRaw);
    // 阶梯价保留原文、价格留空，绝不从「5千内-0.9元」里取一个数字当单价
    const nums = tiered ? [] : numbersIn(priceRaw);
    // 没价格也没规格的行多半是空行 / 图片占位行，跳过
    if (!nums.length && !spec && !name && !priceRaw) continue;

    const extra: string[] = [];
    for (const pc of otherPriceCols) {
      const v = clean(c[pc]);
      if (v && numbersIn(v).length) extra.push(`${clean(header[pc])}：${v}`);
    }
    const currencyCell = cols.currency >= 0 ? clean(c[cols.currency]) : '';
    const currency = currencyCell ? currencyCell.toUpperCase() : fileCurrency;

    out.push({
      型号: currentSku,
      名称: name,
      规格: spec,
      材质: currentMaterial,
      价格: nums.length ? nums[0] : null,
      价格原文: priceRaw,
      附加价格: extra.join('；'),
      币种: currency,
      货期: currentLead,
      MOQ: cols.moq >= 0 ? clean(c[cols.moq]) : '',
      系列: series,
      备注: [
        cols.note >= 0 ? clean(c[cols.note]) : '',
        usedNameAsSku ? '型号列是单元格图片，这里按「产品类型」列代替，请人工核对' : '',
        skuFallback ? '本表型号列含单元格图片，型号可能沿用上一行；请按文件名 + 工作表 + 行号打开原表核对' : '',
        tiered ? '阶梯价 / 多档价，不能自动取数，请打开原表核对这一行' : '',
      ].filter(Boolean).join('；'),
      识别方式: '标准表头',
      关键词: [currentSku, name, spec, series].filter(Boolean).join(' ').toLowerCase(),
      文件: fileName,
      工作表: sheet.name,
      行号: r.row,
    });
  }
  return out;
}

function guessCurrency(fileName: string, sheets: Array<{ name: string; rows: Array<{ row: number; cells: string[] }> }>): string {
  const head = (sheets[0]?.rows.slice(0, 6).flatMap((r) => r.cells) ?? []).join(' ');
  if (/USD|美元|美金|\(usd\)/i.test(head) || /USD/i.test(fileName)) return 'USD';
  if (/EUR|欧元/i.test(head)) return 'EUR';
  return 'CNY'; // 国内工厂报价表默认是人民币出厂价
}

interface CacheEntry {
  sig: string;
  报价: QuoteRow[];
  文件: IndexedFile;
}
type CacheMap = Record<string, CacheEntry>;

function loadCache(): CacheMap {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as CacheMap;
  } catch {
    return {};
  }
}

let indexCache: { stamp: string; index: LibraryIndex } | null = null;

/** 取当前索引（带文件时间戳校验，改了文件会自动失效） */
export function getIndex(): LibraryIndex | null {
  if (!fs.existsSync(INDEX_FILE)) return null;
  try {
    const stamp = `${fs.statSync(INDEX_FILE).mtimeMs}:${fs.statSync(INDEX_FILE).size}`;
    if (indexCache && indexCache.stamp === stamp) return indexCache.index;
    const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) as LibraryIndex;
    indexCache = { stamp, index };
    return index;
  } catch {
    return null;
  }
}

export function libraryStatus(): Record<string, unknown> {
  const index = getIndex();
  const files: string[] = [];
  if (fs.existsSync(cfg.kbRoot)) walk(cfg.kbRoot, 0, files);
  const tableCount = files.filter((f) => TABLE_EXT.test(f)).length;
  let stale = false;
  if (index) {
    // 用「文件大小 + 修改时间」签名对比缓存，比拿文件时间和生成时间比更准
    const cache = loadCache();
    const now = files.map((f) => rel(cfg.kbRoot, f));
    const nowSet = new Set(now);
    stale = Object.keys(cache).length === 0 ||
      now.length !== Object.keys(cache).length ||
      Object.keys(cache).some((p) => !nowSet.has(p)) ||
      now.some((p) => {
        const abs = path.join(cfg.kbRoot, p);
        if (!fs.existsSync(abs)) return true;
        const st = fs.statSync(abs);
        return cache[p]?.sig !== `${st.size}:${Math.round(st.mtimeMs)}`;
      });
  }
  return {
    ok: !!index,
    已整理: !!index,
    需要重新整理: !index || stale,
    生成时间: index?.生成时间 ?? null,
    统计: index?.统计 ?? null,
    资料文件夹: cfg.kbRoot,
    当前文件数: files.length,
    当前表格数: tableCount,
    型号示例: (index?.型号目录 ?? []).slice(0, 6).map((m) => m.型号),
    索引路径: INDEX_FILE,
    清单路径: LIST_FILE,
    提示: !index
      ? '资料库还没有整理，点「一键整理资料」就能把报价表变成可检索的资料。'
      : stale
        ? '资料文件夹里有新增或修改过的文件，建议再整理一次（程序也会自动整理）。'
        : '资料库已关联，AI 可以查到里面的型号和价格。',
  };
}

/** 把索引写成一份人能看懂的中文清单，方便用户自己核对「到底认出了什么」 */
function writeList(index: LibraryIndex): void {
  const s = index.统计;
  const lines: string[] = [
    '# 我的资料库清单（程序自动生成，可以直接看，不用改）',
    '',
    `生成时间：${index.生成时间}`,
    `资料文件夹：\`${index.资料文件夹}\``,
    '',
    '## 一句话结论',
    `已关联 **${s.文件数} 个文件**，其中 **${s.报价表数} 个报价表**认出了 **${s.报价行数} 行报价**、**${s.型号数} 个型号**；另有 ${s.图片数} 张独立图片、${s.文档数} 份文档 / 证书，报价表内还嵌着 ${s.内嵌图片} 张产品图。`,
    '',
    '> 这份清单和索引都是程序生成的，你的原始文件一个字都没动。价格、货期请打开来源文件的对应行人工核对。',
    '',
    '## 报价表识别情况',
    '',
    '| 文件 | 类型 | 识别行数 | 内嵌图片 | 状态 |',
    '| --- | --- | ---: | ---: | --- |',
  ];
  for (const f of index.文件.filter((x) => x.类型 === '报价表')) {
    lines.push(`| ${f.路径} | ${f.类型} | ${f.提取行数} | ${f.内嵌图片} | ${f.识别状态} |`);
  }
  lines.push('', '## 型号速查（前 40 个）', '', '| 型号 | 价格范围 | 币种 | 系列 | 来源文件 |', '| --- | --- | --- | --- | --- |');
  for (const m of index.型号目录.slice(0, 40)) {
    lines.push(`| ${m.型号} | ${m.价格范围} | ${m.币种} | ${m.系列} | ${m.来源文件} |`);
  }
  lines.push('', '## 其他资料', '');
  for (const f of index.文件.filter((x) => x.类型 !== '报价表')) {
    lines.push(`- \`${f.路径}\`（${f.类型}，${(f.大小 / 1024).toFixed(0)} KB）${f.说明}`);
  }
  lines.push('', '## 整理建议', '');
  if (index.建议.length === 0) lines.push('- 资料整理得很规整，暂时没有建议。');
  else for (const t of index.建议) lines.push(`- ${t}`);
  lines.push('', '## 资料怎么放最容易查到', '');
  lines.push('1. 报价表直接放进资料文件夹（放子文件夹里也行），文件名带上年份和品类更清楚。');
  lines.push('2. 表里要有「型号」和「价格 / 出厂价 / 单价」两列就行，中文列名、合并单元格、一格多个价格都能识别。');
  lines.push('3. 产品图片建议放进 `图片` 子文件夹，文件名带上型号（例如 `型号_主图.jpg`），这样按型号就能找到。');
  lines.push('4. 嵌在 Excel 里的产品图会建立本地指纹索引，可以按图查价；老式 .xls 的单元格图片也支持。库存表更新后记得点「重建图片索引」。');
  lines.push('5. 老式 `.xls` 已支持只读解析（只取文字流，几百 MB 图片流跳过）；`~$` 开头的临时文件会自动跳过。');
  lines.push('6. 新增或改过文件后，点界面上的「🗂 一键整理资料」，或等程序自动整理（每 30 分钟查一次）。');
  lines.push('');
  fs.writeFileSync(LIST_FILE, lines.join('\n'), 'utf8');
}

function buildSuggestions(index: LibraryIndex, unrecognized: IndexedFile[]): string[] {
  const tips: string[] = [];
  for (const f of unrecognized.filter((x) => x.类型 === '报价表' && !/价格列未填写/.test(x.识别状态))) {
    tips.push(`「${f.路径}」没能认出表头：${f.说明}。请把表头行写成包含「型号」和「价格 / 出厂价 / 单价」两列，或删掉表头前面的合并大标题。`);
  }
  const hashImages = index.文件.filter((f) => f.类型 === '图片' && /^[0-9a-f]{8,}|微信图片_|IMG_/i.test(path.basename(f.路径)));
  if (hashImages.length) {
    tips.push(`有 ${hashImages.length} 张图片是哈希 / 微信默认名（例如 ${path.basename(hashImages[0].路径)}），按型号搜不到。建议把常用的改成「型号_角度.jpg」，不改也不影响报价查询。`);
  }
  if (index.统计.内嵌图片 > 0) {
    tips.push(`报价表里嵌了 ${index.统计.内嵌图片} 张产品图，已统计数量；若客户常要图片，建议把主图另存到「图片」子文件夹并按型号命名。`);
  }
  const stockTables = index.文件.filter((f) => /\.xls$/i.test(f.路径) && /价格列未填写/.test(f.识别状态));
  if (stockTables.length) {
    tips.push(
      `${stockTables.length} 个库存表目前价格列是空的（库存尚未更新），已读取工作表但不产生报价行。` +
      '这些表里的数量、型号、产品图会随实际库存随时变化，程序不会把它们写死：回复客户时一律写「待人工补充」，由客服打开当前库存表核对。',
    );
  }
  const cellImageTables = index.文件.filter((f) => /单元格图片/.test(f.说明));
  if (cellImageTables.length) {
    tips.push('库存表里的单元格图片已可用于按图查价，但它只是当前库存的产品照片：库存或产品图变动后要重建图片索引，别沿用历史聊天里的图片，发图前请人工核对。');
  }

  const looseRows = index.报价.filter((q) => q.识别方式 === '宽松识别').length;
  if (looseRows) {
    tips.push(`有 ${looseRows} 行来自「没有标准表头」的双栏款式表，价格是按行推测的，答复客户前务必打开原表核对；想让结果更准，可以把这类表另存成「型号 / 价格 / 货期」各一列的简表。`);
  }

  // 同一份报价表存了多个日期版本时，程序按文件顺序取第一个命中，容易用到旧价
  const keys = index.文件
    .filter((f) => f.类型 === '报价表')
    .map((f) => path.basename(f.路径).replace(/\.[^.]+$/, '').replace(/[\d\s._\-]/g, '').toLowerCase())
    .filter((k) => k.length >= 5);
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dup.length) {
    tips.push(`检测到几个几乎同名的报价表版本（例如 ${dup[0]}…）。程序会按文件顺序取第一个命中的价格，建议只保留最新版，或把旧版放进「历史报价」子文件夹，避免报到旧价。`);
  }
  if (!tips.length) tips.push('资料已经能被程序检索；以后新增文件，点一次「一键整理资料」即可。');
  return tips;
}

/** 真正执行整理；force=true 时忽略缓存全部重读 */
export function organizeLibrary(options: { force?: boolean } = {}): OrganizeResult {
    const t0 = Date.now();
    const root = cfg.kbRoot;
    fs.mkdirSync(path.join(cfg.root, 'data'), { recursive: true });
    if (!fs.existsSync(root)) {
      const result: OrganizeResult = {
        ok: false, 摘要: `没找到资料文件夹：${root}。请在「一键启动」菜单 7 打开资料文件夹，把报价表放进去再整理。`,
        生成时间: new Date().toISOString(), 耗时毫秒: Date.now() - t0,
        统计: { 文件数: 0, 报价表数: 0, 图片数: 0, 文档数: 0, 报价行数: 0, 型号数: 0, 内嵌图片: 0, 未识别文件: 0 },
        新增文件: [], 变更文件: [], 建议: ['先创建资料文件夹并放入报价表。'], 索引路径: INDEX_FILE, 清单路径: LIST_FILE,
      };
      return result;
    }

    const all: string[] = [];
    walk(root, 0, all);
    const oldIndex = getIndex();
    const oldPaths = new Set((oldIndex?.文件 ?? []).map((f) => f.路径));
    const cache = options.force ? {} : loadCache();
    const newCache: CacheMap = {};
    const files: IndexedFile[] = [];
    let quotes: QuoteRow[] = [];
    const added: string[] = [];
    const changed: string[] = [];

    for (const abs of all) {
      const relPath = rel(root, abs);
      const st = fs.statSync(abs);
      const sig = `${st.size}:${Math.round(st.mtimeMs)}`;
      const type = fileType(abs);
      const cached = cache[relPath];
      if (!oldPaths.has(relPath)) added.push(relPath);

      if (cached && cached.sig === sig) {
        files.push(cached.文件);
        quotes = quotes.concat(cached.报价);
        newCache[relPath] = cached;
        continue;
      }
      if (oldPaths.has(relPath)) changed.push(relPath);

      const info: IndexedFile = {
        路径: relPath, 类型: type, 大小: st.size,
        修改时间: new Date(st.mtimeMs).toISOString(),
        识别状态: '无需解析', 提取行数: 0, 工作表数: 0, 内嵌图片: 0, 说明: '',
      };
      let extracted: QuoteRow[] = [];

      if (type === '报价表') {
        try {
          const isXls = /\.xls$/i.test(abs) && !/\.xlsx$/i.test(abs);
          const isOoxml = /\.xlsx$|\.xlsm$/i.test(abs);
          const parsedXls = isXls ? readXlsTextWithRows(abs) : null;
          const sheets = parsedXls ? parsedXls.sheets : isOoxml ? readXlsxTextWithRows(abs) : readCsvRows(abs);
          const images = parsedXls ? parsedXls.cellImages : isOoxml ? countEmbeddedImages(abs) : 0;
          const currency = guessCurrency(path.basename(abs), sheets);
          info.工作表数 = sheets.length;
          // 老式 .xls 的单元格图片也能建图片索引（ETCellImageData），数量照实统计
          info.内嵌图片 = images;
          const skuFallback = Boolean(parsedXls && parsedXls.cellImages > 0);
          for (const sheet of sheets) extracted = extracted.concat(extractSheet(sheet, relPath, currency, skuFallback));
          if (isXls) {
            // 价格列没填的行不是报价：库存表当前未更新，绝不拿数量当价格、也绝不把空价当可报价数据
            extracted = extracted.filter((q) => q.价格 !== null || q.附加价格);
          }
          info.提取行数 = extracted.length;
          if (extracted.length) {
            const loose = extracted.filter((q) => q.识别方式 === '宽松识别').length;
            info.识别状态 = loose
              ? `已识别 ${extracted.length} 行（其中 ${loose} 行按无表头款式推测，需人工核对）`
              : `已识别 ${extracted.length} 行报价`;
            info.说明 = [
              isXls && images ? `另有 ${images} 张单元格图片（可建图片索引按图查价；图片随当前库存表变化）` : '',
              !isXls && images ? `表内还嵌着 ${images} 张产品图（已统计，未改动原文件）` : '',
              isXls ? '价格来自本表真实行列，属出厂价 / 内部价；发给客户前请打开原表核对' : '',
            ].filter(Boolean).join('；');
          } else if (isXls) {
            info.识别状态 = `已读取 ${sheets.length} 个工作表 · 价格列未填写`;
            info.说明 = '这是库存表：数量 / 型号 / 产品图会随实际库存变化，当前价格未更新，不参与报价；涉及库存数量与产品图请写「待人工补充」。';
          } else {
            info.识别状态 = '未能识别：找不到「型号 + 价格」表头';
            info.说明 = '表头需同时含「型号」和「价格 / 出厂价 / 单价」两列';
          }
        } catch (e) {
          info.识别状态 = '读取失败';
          info.说明 = `这个文件可能损坏或不是标准表格：${(e as Error).message.slice(0, 80)}`;
        }
      } else if (type === '图片') {
        info.说明 = /^[0-9a-f]{8,}|微信图片_|IMG_/i.test(path.basename(abs))
          ? '文件名不含型号，按型号搜不到；建议改成「型号_角度.jpg」' : '可按文件名中的型号检索';
      } else if (type === '文档 / 证书') {
        info.说明 = '可按文件名检索，内容未做全文解析';
      }
      files.push(info);
      quotes = quotes.concat(extracted);
      newCache[relPath] = { sig, 报价: extracted, 文件: info };
    }

    // 型号目录：按型号聚合，给出价格区间，方便「有没有某款 / 大概多少钱」这类问题
    const byModel = new Map<string, QuoteRow[]>();
    for (const q of quotes) {
      if (!q.型号) continue;
      const arr = byModel.get(q.型号) ?? [];
      arr.push(q);
      byModel.set(q.型号, arr);
    }
    const models: ModelEntry[] = [...byModel.entries()].map(([型号, rows]) => {
      const prices = rows.map((r) => r.价格).filter((p): p is number => typeof p === 'number' && p > 0);
      const cur = rows[0]?.币种 ?? 'CNY';
      return {
        型号, 出现次数: rows.length,
        价格范围: prices.length ? (Math.min(...prices) === Math.max(...prices) ? `${Math.min(...prices)}` : `${Math.min(...prices)} ~ ${Math.max(...prices)}`) : '未填价格',
        币种: cur, 系列: rows[0]?.系列 ?? '', 示例名称: rows[0]?.名称 || rows[0]?.规格 || '',
        来源文件: rows[0]?.文件 ?? '',
      };
    }).sort((a, b) => a.型号.localeCompare(b.型号, 'zh-CN'));

    const unrecognized = files.filter((f) => f.类型 === '报价表' && !f.提取行数);
    const stats: LibraryIndex['统计'] = {
      文件数: files.length,
      报价表数: files.filter((f) => f.类型 === '报价表').length,
      图片数: files.filter((f) => f.类型 === '图片').length,
      文档数: files.filter((f) => f.类型 === '文档 / 证书').length,
      报价行数: quotes.length,
      型号数: models.length,
      内嵌图片: files.reduce((n, f) => n + f.内嵌图片, 0),
      未识别文件: unrecognized.length,
    };
    const index: LibraryIndex = {
      版本: INDEX_VERSION, 生成时间: new Date().toISOString(), 资料文件夹: root,
      统计: stats, 文件: files, 报价: quotes, 型号目录: models, 建议: [],
    };
    index.建议 = buildSuggestions(index, unrecognized);
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2) + '\n', 'utf8');
    fs.writeFileSync(CACHE_FILE, JSON.stringify(newCache) + '\n', 'utf8');
    writeList(index);
    indexCache = { stamp: `${fs.statSync(INDEX_FILE).mtimeMs}:${fs.statSync(INDEX_FILE).size}`, index };

    const bits = [
      `已关联 ${stats.报价表数} 个报价表，认出 ${stats.型号数} 个型号、${stats.报价行数} 行报价`,
      `${stats.图片数} 张图片、${stats.文档数} 份文档 / 证书`,
    ];
    if (stats.内嵌图片) bits.push(`报价表内嵌 ${stats.内嵌图片} 张产品图（已统计）`);
    if (added.length) bits.push(`新增 ${added.length} 个文件`);
    if (changed.length) bits.push(`更新 ${changed.length} 个文件`);
    if (unrecognized.length) bits.push(`有 ${unrecognized.length} 个表格没认出表头（见清单）`);
    const 摘要 = bits.join('；') + '。你的原始文件一个都没改动。';

    return {
      ok: true, 摘要, 生成时间: index.生成时间, 耗时毫秒: Date.now() - t0,
      统计: stats, 新增文件: added.slice(0, 20), 变更文件: changed.slice(0, 20),
      建议: index.建议, 索引路径: INDEX_FILE, 清单路径: LIST_FILE,
    };
}

/** 供 AI 用的关键词检索：型号 / 名称 / 系列 / 规格 / 文件名 */
export function searchLibrary(keyword: string, limit = 8): Record<string, unknown> {
  const index = getIndex();
  const kw = String(keyword ?? '').trim().toLowerCase();
  if (!index) return { ok: false, data: { hint: '资料库还没整理，请先点界面上的「一键整理资料」' } };
  if (!kw) return { ok: true, data: { 型号: index.型号目录.slice(0, limit).map((m) => ({ ...m })), 文件: index.文件.slice(0, limit) } };

  const normKw = kw.replace(/[\s_\-#]/g, '');
  const hitQuotes = index.报价.filter((q) => {
    const hay = `${q.型号} ${q.名称} ${q.规格} ${q.系列} ${q.文件}`.toLowerCase();
    return hay.includes(kw) || hay.replace(/[\s_\-#]/g, '').includes(normKw);
  });
  const modelHits = index.型号目录.filter((m) => {
    const hay = `${m.型号} ${m.系列} ${m.示例名称}`.toLowerCase();
    return hay.includes(kw) || hay.replace(/[\s_\-#]/g, '').includes(normKw);
  }).slice(0, limit);
  const fileHits = index.文件.filter((f) => f.路径.toLowerCase().includes(kw)).slice(0, limit);
  if (!hitQuotes.length && !modelHits.length && !fileHits.length) {
    return { ok: false, data: { hint: `资料库里没有找到「${keyword}」，禁止虚构价格或文件名，请写「待人工补充」`, 型号示例: index.型号目录.slice(0, 5).map((m) => m.型号) } };
  }
  return {
    ok: true,
    data: {
      命中行数: hitQuotes.length,
      型号: modelHits,
      报价明细: hitQuotes.slice(0, limit).map((q) => ({
        型号: q.型号, 名称: q.名称, 规格: q.规格, 价格: q.价格, 价格原文: q.价格原文,
        附加价格: q.附加价格, 币种: q.币种, 货期: q.货期, 系列: q.系列,
        识别方式: q.识别方式, 备注: q.备注,
        文件: q.文件, 工作表: q.工作表, 行号: q.行号,
      })),
      文件: fileHits,
      提示: '价格、货期来自你的资料库，仍须打开来源文件对应行人工核对；标记「宽松识别」的行是按原表排版推测的，更要核对；这不是对外正式报价。',
    },
  };
}

/** 启动时和定时调用：只有文件真的变了才重建，避免白跑 */
export function autoOrganizeIfNeeded(): { ran: boolean; 摘要?: string } {
  const status = libraryStatus();
  if (!(status.需要重新整理 as boolean)) return { ran: false };
  const r = organizeLibrary();
  return { ran: true, 摘要: r.摘要 };
}
