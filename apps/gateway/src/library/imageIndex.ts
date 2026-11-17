import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { cfg } from '../config.js';
import { listZipEntries, readZipEntry, type ZipEntry } from './zipReader.js';
import { getIndex, organizeLibrary, type QuoteRow } from './organizer.js';
import { readXlsTextWithRows } from './xlsxText.js';
import { parseXlsCellImages, readXlsEmbeddedMedia } from './xlsCellImages.js';
import {
  decodeImage,
  computeQueryFeatures,
  normalizedFeatures,
  similarity,
  hamming,
  confidenceLabel,
  type ImageFeatures,
} from './imageFeatures.js';

/**
 * 报价表内嵌图片 → 型号 / 出厂价 的索引
 *
 * 和 organizer.ts 一样守三条红线：
 *   ① 只读原始资料，绝不改名、移动、删除或覆盖任何用户文件；
 *   ② 只在 data/ 下写「图片索引.json」和「图片缓存/*.webp」；
 *   ③ 关联不上型号就留空并写进建议，绝不猜价格、绝不编型号。
 *
 * 解析链路（都已用真实报价表核对过）：
 *   workbook.xml + workbook.xml.rels  → 工作表名 ↔ worksheets/sheetN.xml
 *   sheetN.xml 的 <drawing r:id>      → 该表自己的 _rels → drawings/drawingN.xml
 *   drawingN.xml 的 <xdr:twoCellAnchor> → from.row(0-based) + <a:blip r:embed>
 *   drawingN.xml.rels                 → xl/media/imageN.png
 *   Excel 行号 = from.row + 1         → 资料索引.json 的 报价[]（文件+工作表+行号）
 */

const INDEX_FILE = path.join(cfg.root, 'data', '图片索引.json');
const THUMB_DIR = path.join(cfg.root, 'data', '图片缓存');
const VERSION = 2;
/** 指纹算法版本：升级后旧索引里 sig 相同的图也要补算「去白边」指纹，但不用重新解大图 */
const FEATURE_VERSION = 2;
const MEDIA_LIMIT = 48 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const XLSX_EXT = /\.(xlsx|xlsm)$/i;
/** 老式 OLE2 .xls：图片在 ETCellImageData 流里，靠 DISPIMG 单元格定位 */
const XLS_EXT = /\.xls$/i;

export interface ImageEntry {
  id: string;
  来源: '报价表内嵌' | '独立图片';
  /** xls = 图片在 ETCellImageData 流里；xlsx / 缺省 = 图片在 xlsx 的 zip 条目里 */
  容器?: 'xlsx' | 'xls';
  media: string;
  文件: string;
  工作表: string;
  行号: number;
  列: number;
  型号: string;
  名称: string;
  规格: string;
  价格: number | null;
  价格原文: string;
  币种: string;
  货期: string;
  附加价格: string;
  系列: string;
  关联方式: '行号精确' | '就近行' | '文件名' | '未关联';
  原图宽: number;
  原图高: number;
  字节数: number;
  sig: string;
  thumb: string;
  f: ImageFeatures;
  /** 同一张图裁掉浅色底 / 表格边框后的指纹；客户从单元格复制的图带白边时靠它对上 */
  fn?: ImageFeatures | null;
  /** 生成 f / fn 的指纹算法版本，升级后旧索引自动补算 */
  特征版本?: number;
}

export interface ImageIndex {
  版本: number;
  特征版本: number;
  生成时间: string;
  耗时毫秒: number;
  统计: {
    图片数: number;
    有关联型号: number;
    未关联型号: number;
    报价表数: number;
    新建缩略图: number;
    复用缩略图: number;
    解码失败: number;
  };
  图片: ImageEntry[];
  建议: string[];
}

export interface ImageMatch {
  id: string;
  相似度: number;
  置信度: '高' | '中' | '低';
  d距离: number;
  p距离: number;
  型号: string;
  名称: string;
  规格: string;
  价格: number | null;
  价格原文: string;
  币种: string;
  货期: string;
  附加价格: string;
  系列: string;
  关联方式: ImageEntry['关联方式'];
  文件: string;
  工作表: string;
  行号: number;
  缩略图: string;
  来源: string;
  hint: string;
}

export interface BuildState {
  running: boolean;
  phase: string;
  done: number;
  total: number;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  摘要: string | null;
}

let buildState: BuildState = freshState();
function freshState(): BuildState {
  return {
    running: false, phase: '空闲', done: 0, total: 0, message: '还没建过图片索引',
    startedAt: null, finishedAt: null, error: null, 摘要: null,
  };
}

export function getBuildState(): BuildState {
  return { ...buildState };
}

let indexCache: { stamp: string; index: ImageIndex } | null = null;

export function getImageIndex(): ImageIndex | null {
  if (!fs.existsSync(INDEX_FILE)) return null;
  try {
    const st = fs.statSync(INDEX_FILE);
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (indexCache && indexCache.stamp === stamp) return indexCache.index;
    const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) as ImageIndex;
    indexCache = { stamp, index };
    return index;
  } catch {
    return null;
  }
}

/* ---------------------------------- 小工具 ---------------------------------- */

function attr(attrs: string, key: string): string {
  const m = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}="([^"]*)"`).exec(attrs);
  return m ? m[1] : '';
}

/** _rels/*.rels 的 Target 是相对「关系文件所在目录去掉 _rels」的路径 */
function resolveZipPath(relsFile: string, target: string): string {
  const base = path.posix.dirname(relsFile).replace(/\/_rels$/i, '');
  return path.posix.normalize(path.posix.join(base, target.replace(/^\//, ''))).replace(/\\/g, '/');
}

function parseRels(xml: string, relsFile: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) out.set(id, resolveZipPath(relsFile, target));
  }
  return out;
}

function shortId(...parts: Array<string | number>): string {
  return crypto.createHash('sha1').update(parts.join('\u0001')).digest('hex').slice(0, 16);
}

function normSku(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[\s_\-#()（）]/g, '');
}

interface Anchor {
  media: string; // zip 内路径
  row: number; // Excel 1-based
  col: number; // 0-based
  seq: number;
}

/* ------------------------ 解析一个 xlsx 的图片锚点 ------------------------ */

export function parseXlsxAnchors(file: string): Array<{ sheet: string; anchors: Anchor[] }> {
  const entries = listZipEntries(file);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const read = (name: string): string => {
    const e = byName.get(name);
    if (!e) return '';
    try {
      return readZipEntry(file, e, MEDIA_LIMIT).toString('utf8');
    } catch {
      return '';
    }
  };

  const wbRelsFile = 'xl/_rels/workbook.xml.rels';
  const wbRels = parseRels(read(wbRelsFile), wbRelsFile);
  const sheets: Array<{ name: string; file: string }> = [];
  for (const m of read('xl/workbook.xml').matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const name = attr(m[1], 'name');
    const rid = attr(m[1], 'r:id') || attr(m[1], 'id');
    const f = wbRels.get(rid);
    if (f) sheets.push({ name, file: f });
  }
  if (!sheets.length) {
    for (const e of entries) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(e.name)) sheets.push({ name: e.name, file: e.name });
    }
  }

  const out: Array<{ sheet: string; anchors: Anchor[] }> = [];
  for (const sheet of sheets) {
    const sheetXml = read(sheet.file);
    const drawingRid = /<drawing\b[^>]*r:id="([^"]+)"/.exec(sheetXml)?.[1];
    if (!drawingRid) continue;
    const sheetRelsFile = `${path.posix.dirname(sheet.file)}/_rels/${path.posix.basename(sheet.file)}.rels`;
    const drawingFile = parseRels(read(sheetRelsFile), sheetRelsFile).get(drawingRid);
    if (!drawingFile) continue;
    const drawingXml = read(drawingFile);
    if (!drawingXml) continue;
    const drawingRelsFile = `${path.posix.dirname(drawingFile)}/_rels/${path.posix.basename(drawingFile)}.rels`;
    const mediaById = parseRels(read(drawingRelsFile), drawingRelsFile);

    const anchors: Anchor[] = [];
    const anchorRe = /<xdr:(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[^>]*>([\s\S]*?)<\/xdr:\1>/g;
    let seq = 0;
    for (const am of drawingXml.matchAll(anchorRe)) {
      const body = am[2];
      const fromRow = /<xdr:from\b[^>]*>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/.exec(body)?.[1];
      const fromCol = /<xdr:from\b[^>]*>[\s\S]*?<xdr:col>(\d+)<\/xdr:col>/.exec(body)?.[1];
      if (fromRow === undefined) continue;
      for (const bm of body.matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/g)) {
        const media = mediaById.get(bm[1]);
        if (!media) continue;
        anchors.push({
          media,
          row: Number(fromRow) + 1, // drawing 是 0-based，Excel 行号是 1-based
          col: Number(fromCol ?? 0),
          seq: seq++,
        });
      }
    }
    if (anchors.length) out.push({ sheet: sheet.name, anchors });
  }
  return out;
}

/* --------------------------- 报价行关联 --------------------------- */

interface QuoteLookupMap {
  exact: Map<string, QuoteRow>;
  bySheet: Map<string, QuoteRow[]>;
  byModel: Map<string, QuoteRow>;
}

const qkey = (file: string, sheet: string, row: number): string => `${file}\u0000${sheet}\u0000${row}`;
const skey = (file: string, sheet: string): string => `${file}\u0000${sheet}`;
const mkey = (file: string, sku: string): string => `${file}\u0000${normSku(sku)}`;

function buildQuoteMap(quotes: QuoteRow[]): QuoteLookupMap {
  const exact = new Map<string, QuoteRow>();
  const bySheet = new Map<string, QuoteRow[]>();
  const byModel = new Map<string, QuoteRow>();
  for (const q of quotes) {
    exact.set(qkey(q.文件, q.工作表, q.行号), q);
    const k = skey(q.文件, q.工作表);
    const arr = bySheet.get(k) ?? [];
    arr.push(q);
    bySheet.set(k, arr);
    if (q.型号) {
      const mk = mkey(q.文件, q.型号);
      // 同一型号常有两行（1.8m / 1.5m），优先留带价格的那行
      if (!byModel.has(mk) || (typeof q.价格 === 'number' && q.价格 > 0 && byModel.get(mk)?.价格 == null)) {
        byModel.set(mk, q);
      }
    }
  }
  for (const arr of bySheet.values()) arr.sort((a, b) => a.行号 - b.行号);
  return { exact, bySheet, byModel };
}

interface LinkedQuote {
  q: QuoteRow | null;
  link: ImageEntry['关联方式'];
}

/** 图片锚点行 → 报价行；精确优先，其次就近向上取 4 行内最近的一行 */
function linkQuote(file: string, sheet: string, row: number, map: QuoteLookupMap): LinkedQuote {
  const hit = map.exact.get(qkey(file, sheet, row));
  if (hit) return { q: hit, link: '行号精确' };
  const rows = map.bySheet.get(skey(file, sheet)) ?? [];
  let best: QuoteRow | null = null;
  for (const q of rows) {
    if (q.行号 > row) break;
    best = q;
  }
  if (best && row - best.行号 <= 4) return { q: best, link: '就近行' };
  return { q: null, link: '未关联' };
}

function metaFromQuote(q: QuoteRow | null, link: ImageEntry['关联方式']): Pick<
  ImageEntry,
  '型号' | '名称' | '规格' | '价格' | '价格原文' | '币种' | '货期' | '附加价格' | '系列' | '关联方式'
> {
  if (!q) {
    return {
      型号: '', 名称: '', 规格: '', 价格: null, 价格原文: '', 币种: '', 货期: '',
      附加价格: '', 系列: '', 关联方式: link,
    };
  }
  return {
    型号: q.型号, 名称: q.名称, 规格: q.规格, 价格: q.价格, 价格原文: q.价格原文,
    币种: q.币种, 货期: q.货期, 附加价格: q.附加价格, 系列: q.系列, 关联方式: link,
  };
}

/** 同一型号若锚点落在无价格的子规格行，用带价格的那行补全 */
function fillPrice(meta: ReturnType<typeof metaFromQuote>, file: string, map: QuoteLookupMap): ReturnType<typeof metaFromQuote> {
  if (!meta.型号 || meta.价格 != null) return meta;
  const priced = map.byModel.get(mkey(file, meta.型号));
  if (!priced || priced.价格 == null) return meta;
  return { ...meta, 价格: priced.价格, 价格原文: priced.价格原文, 货期: meta.货期 || priced.货期 };
}

/**
 * 老式 .xls 里没填价格的行：只取同一行真实写着的「型号 / 产品类型 / 名称」文字，
 * 用来告诉客服「这是哪一款、去第几行核对」。绝不当成型号去查价，也绝不带出任何价格。
 * 型号列若是 =DISPIMG 图片，readXlsTextWithRows 已把它置空，这里自然取不到。
 */
function xlsRowLabels(file: string): Map<string, string> {
  const out = new Map<string, string>();
  let sheets: ReturnType<typeof readXlsTextWithRows>['sheets'];
  try {
    sheets = readXlsTextWithRows(file).sheets;
  } catch {
    return out;
  }
  for (const sheet of sheets) {
    const rows = sheet.rows;
    if (!rows.length) continue;
    const header = rows.slice(0, 3).find((r) =>
      r.cells.some((c) => /^(name|产品类型|名称)/i.test(c.replace(/\s+/g, ''))),
    ) ?? rows[0];
    const nameCols: number[] = [];
    const modelCols: number[] = [];
    header.cells.forEach((c, i) => {
      const h = c.replace(/\s+/g, '');
      // 「Choose Model / Choose Color」不是型号列，必须整列以 Model / 型号 开头才算
      if (/^(model|型号)/i.test(h)) modelCols.push(i);
      else if (/^(name|产品类型|名称)/i.test(h)) nameCols.push(i);
    });
    if (!nameCols.length && !modelCols.length) continue;
    for (const r of rows) {
      const parts = [...modelCols, ...nameCols]
        .map((i) => (r.cells[i] ?? '').replace(/\s+/g, ' ').trim())
        .filter((s) => s && !s.startsWith('=') && !/^\d+(?:\.\d+)?$/.test(s));
      const label = [...new Set(parts)].join(' · ').slice(0, 80);
      if (label) out.set(`${sheet.name}|${r.row}`, label);
    }
  }
  return out;
}

/* --------------------------- 索引构建 --------------------------- */

interface Pending {
  id: string;
  来源: ImageEntry['来源'];
  容器?: ImageEntry['容器'];
  media: string;
  文件: string;
  工作表: string;
  行号: number;
  列: number;
  meta: ReturnType<typeof metaFromQuote>;
  sig: string;
  bytes: number;
  load: () => Buffer;
}

function collectPending(force: boolean): { pending: Pending[]; quoteFiles: number; libraryTime: string } {
  let lib = getIndex();
  if (!lib) {
    organizeLibrary();
    lib = getIndex();
  }
  if (!lib) throw new Error('资料库还没整理好：请先运行 npm run organize:library');
  const map = buildQuoteMap(lib.报价);
  const pending: Pending[] = [];
  let quoteFiles = 0;

  const files = lib.文件.filter((f) => {
    const abs = path.join(cfg.kbRoot, f.路径);
    return fs.existsSync(abs) && (XLSX_EXT.test(f.路径) || XLS_EXT.test(f.路径) || IMAGE_EXT.test(f.路径));
  });

  for (const f of files) {
    const relPath = f.路径;
    const abs = path.join(cfg.kbRoot, relPath);
    const st = fs.statSync(abs);
    const fileSig = `${st.size}:${Math.round(st.mtimeMs)}`;

    if (XLSX_EXT.test(relPath)) {
      quoteFiles++;
      let sheetAnchors: ReturnType<typeof parseXlsxAnchors> = [];
      try {
        sheetAnchors = parseXlsxAnchors(abs);
      } catch (e) {
        buildState.error = `${relPath}：${(e as Error).message}`;
        continue;
      }
      const entries = listZipEntries(abs);
      const byName = new Map<string, ZipEntry>(entries.map((e) => [e.name, e]));
      for (const sa of sheetAnchors) {
        for (const a of sa.anchors) {
          const mediaEntry = byName.get(a.media);
          if (!mediaEntry || mediaEntry.size === 0) continue;
          if (!mediaEntry.name || mediaEntry.size > MEDIA_LIMIT) continue;
          const linked = linkQuote(relPath, sa.sheet, a.row, map);
          const meta = fillPrice(metaFromQuote(linked.q, linked.link), relPath, map);
          const id = shortId(relPath, a.media, a.seq, sa.sheet);
          pending.push({
            id, 来源: '报价表内嵌', media: a.media, 文件: relPath, 工作表: sa.sheet,
            行号: a.row, 列: a.col, meta, sig: `${fileSig}:${mediaEntry.size}:${a.row}`,
            bytes: mediaEntry.size,
            load: () => readZipEntry(abs, mediaEntry, MEDIA_LIMIT),
          });
        }
      }
    } else if (XLS_EXT.test(relPath)) {
      // 老式 .xls：ETCellImageData 流里的单元格图片，用 DISPIMG 公式定位到工作表 + 行号
      quoteFiles++;
      let table: ReturnType<typeof parseXlsCellImages>;
      try {
        table = parseXlsCellImages(abs);
      } catch (e) {
        buildState.error = `${relPath}：${(e as Error).message}`;
        continue;
      }
      const labels = xlsRowLabels(abs);
      for (const a of table.anchors) {
        if (a.bytes <= 0 || a.bytes > MEDIA_LIMIT) continue;
        // 库存表只在部分行填了价格，且型号列本身是单元格图片。
        // 这里只认「同一文件 / 工作表 / 行号」的精确命中，绝不就近套用别行的价格。
        const q = map.exact.get(qkey(relPath, a.sheet, a.row)) ?? null;
        const meta = metaFromQuote(q, q ? '行号精确' : '未关联');
        if (!q) {
          // 这一行没被识别成报价行（通常是价格列还空着）：只补同行真实写着的产品名称，
          // 型号与价格一律留空，回复稿写「待人工补充」。
          meta.名称 = labels.get(`${a.sheet}|${a.row}`) ?? '';
        }
        const id = shortId(relPath, a.media, a.sheet, a.row, a.col);
        pending.push({
          id, 来源: '报价表内嵌', 容器: 'xls', media: a.media, 文件: relPath,
          工作表: a.sheet, 行号: a.row, 列: a.col, meta,
          sig: `${fileSig}:${a.bytes}:${a.row}:${a.col}`, bytes: a.bytes,
          load: () => table.read(a.media, MEDIA_LIMIT),
        });
      }
    } else if (IMAGE_EXT.test(relPath)) {
      // 独立图片：能从文件名看出型号就关联，看不出也照样入指纹库
      const base = path.basename(relPath, path.extname(relPath));
      const guess = /([A-Za-z]{1,6}[-_]?\d{2,6}[A-Za-z0-9#]*)/.exec(base)?.[1] ?? '';
      let q: QuoteRow | null = null;
      if (guess) {
        q = lib.型号目录.find((m) => normSku(m.型号) === normSku(guess))
          ? (map.byModel.get(mkey(relPath, guess)) ?? lib.报价.find((r) => normSku(r.型号) === normSku(guess)) ?? null)
          : null;
      }
      const id = shortId('file', relPath);
      pending.push({
        id, 来源: '独立图片', media: relPath, 文件: relPath, 工作表: '', 行号: 0, 列: 0,
        meta: fillPrice(metaFromQuote(q, q ? '文件名' : '未关联'), relPath, map),
        sig: `${fileSig}`, bytes: st.size,
        load: () => fs.readFileSync(abs),
      });
    }
  }

  // 去重：同一张 media 被多个锚点引用时只留一条（保留有型号的那条）
  const seen = new Map<string, Pending>();
  for (const p of pending) {
    const prev = seen.get(p.id);
    if (!prev || (!prev.meta.型号 && p.meta.型号)) seen.set(p.id, p);
  }
  return { pending: [...seen.values()], quoteFiles, libraryTime: lib.生成时间 };
}

function commitIndex(index: ImageIndex): void {
  fs.mkdirSync(path.join(cfg.root, 'data'), { recursive: true });
  const tmp = `${INDEX_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, INDEX_FILE);
  indexCache = { stamp: `${fs.statSync(INDEX_FILE).mtimeMs}:${fs.statSync(INDEX_FILE).size}`, index };
}

export interface BuildSummary {
  ok: boolean;
  摘要: string;
  耗时毫秒: number;
  统计: ImageIndex['统计'];
  建议: string[];
  索引路径: string;
}

export async function buildImageIndex(options: { force?: boolean; onProgress?: (s: BuildState) => void } = {}): Promise<BuildSummary> {
  const t0 = Date.now();
  buildState = {
    ...freshState(), running: true, phase: '扫描报价表', startedAt: new Date().toISOString(),
    message: '正在读取表格里的图片位置…',
  };
  const tick = (): void => options.onProgress?.({ ...buildState });
  tick();

  try {
    if (!fs.existsSync(cfg.kbRoot)) {
      throw new Error(`没找到资料文件夹：${cfg.kbRoot}`);
    }
    fs.mkdirSync(THUMB_DIR, { recursive: true });

    const { pending, quoteFiles } = collectPending(!!options.force);
    buildState.total = pending.length;
    buildState.phase = '比对指纹';
    buildState.message = `共找到 ${pending.length} 张图片，正在生成指纹和缩略图…`;
    tick();

    const old = options.force ? null : getImageIndex();
    const oldById = new Map((old?.图片 ?? []).map((e) => [e.id, e]));
    const out: ImageEntry[] = [];
    let reused = 0;
    let created = 0;
    let failed = 0;

    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      if (i % 20 === 0 || i === pending.length - 1) {
        buildState.done = i + 1;
        buildState.message = `已处理 ${i + 1} / ${pending.length} 张（复用 ${reused}、新建 ${created}、跳过 ${failed}）`;
        tick();
      }

      const prev = oldById.get(p.id);
      const thumbName = `${p.id}.webp`;
      const thumbAbs = path.join(THUMB_DIR, thumbName);
      const base = {
        id: p.id, 来源: p.来源, 容器: p.容器 ?? 'xlsx', media: p.media, 文件: p.文件, 工作表: p.工作表,
        行号: p.行号, 列: p.列, ...p.meta, sig: p.sig, 字节数: p.bytes, thumb: thumbName,
      };

      if (prev && prev.sig === p.sig && fs.existsSync(thumbAbs)) {
        // 源文件没变：复用指纹与缩略图，只刷新「型号/价格」这类可能随资料索引更新的字段。
        // 老版本索引没有「去白边」指纹时，只用现成缩略图补算一次，不必重新解几百 MB 的库存表。
        let fn = prev.fn ?? null;
        if (prev.特征版本 !== FEATURE_VERSION) {
          try {
            fn = await normalizedFeatures(fs.readFileSync(thumbAbs));
          } catch {
            fn = null;
          }
        }
        out.push({ ...prev, ...base, fn, 特征版本: FEATURE_VERSION });
        reused++;
        continue;
      }

      let decoded: Awaited<ReturnType<typeof decodeImage>> = null;
      try {
        decoded = await decodeImage(p.load());
      } catch {
        decoded = null;
      }
      if (!decoded) {
        failed++;
        continue;
      }
      try {
        fs.writeFileSync(thumbAbs, decoded.thumb);
      } catch {
        failed++;
        continue;
      }
      let fn: ImageFeatures | null = null;
      try {
        fn = await normalizedFeatures(decoded.thumb);
      } catch {
        fn = null;
      }
      out.push({
        ...base, f: decoded.features, fn, 特征版本: FEATURE_VERSION,
        原图宽: decoded.width, 原图高: decoded.height,
      });
      created++;
    }

    const withSku = out.filter((e) => !!e.型号).length;
    const stats: ImageIndex['统计'] = {
      图片数: out.length, 有关联型号: withSku, 未关联型号: out.length - withSku,
      报价表数: quoteFiles, 新建缩略图: created, 复用缩略图: reused, 解码失败: failed,
    };
    const 建议: string[] = [];
    if (stats.图片数 === 0) {
      建议.push('资料库里没有可建索引的产品图。请先把库存表 / 报价表放进 data/客服资料库，点「整理资料」后再点「重建图片索引」；.xlsx 内嵌图与老式 .xls 的单元格图片都支持。');
    }
    if (stats.未关联型号) {
      建议.push(`有 ${stats.未关联型号} 张图所在行没填型号 / 价格（当前库存表尚未更新）。这些图照样能比对，会给出来源位置与原表同一行的产品名称，但型号留空、价格写「待人工补充」，绝不套用别行价格。`);
    }
    if (failed) 建议.push(`有 ${failed} 张图无法解码（格式特殊或文件损坏），已跳过；原始文件未改动。`);
    建议.push('库存表当前尚未更新：图片所在行若没填价格，索引里价格会留空，回复稿必须写「待人工补充」；程序不会就近套用别行的价格。库存或产品图变动后请重建图片索引。');
    建议.push('客户直接从表格单元格复制的图片带白边 / 网格线 / 选中框时，程序会自动裁掉浅色底再比对，不用客服先手动裁；整张报价表截图、多款拼图仍需裁到只剩单个产品。');
    建议.push('识别给的是「最像的几张」和它们在原表里的行号，价格仍是出厂价 / 内部价，发给客户前必须人工打开源文件核对对应行。');

    const index: ImageIndex = {
      版本: VERSION, 特征版本: FEATURE_VERSION, 生成时间: new Date().toISOString(), 耗时毫秒: Date.now() - t0,
      统计: stats, 图片: out, 建议,
    };
    buildState.phase = '写入索引';
    buildState.message = '正在写入 data/图片索引.json…';
    tick();
    commitIndex(index);

    const 摘要 = `已为 ${stats.报价表数} 个报价表建立图片指纹：共 ${stats.图片数} 张图，其中 ${stats.有关联型号} 张关联到型号与出厂价；新建缩略图 ${created} 张、复用 ${reused} 张、跳过 ${failed} 张。你的原始资料一个都没改动。`;
    buildState = {
      ...buildState, running: false, phase: '完成', done: pending.length, total: pending.length,
      finishedAt: new Date().toISOString(), message: 摘要, 摘要,
    };
    tick();
    return { ok: true, 摘要, 耗时毫秒: Date.now() - t0, 统计: stats, 建议, 索引路径: INDEX_FILE };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    buildState = {
      ...buildState, running: false, phase: '失败', finishedAt: new Date().toISOString(),
      error: msg, message: `图片索引没成功：${msg}`,
    };
    tick();
    return {
      ok: false, 摘要: `图片索引没成功：${msg}`, 耗时毫秒: Date.now() - t0,
      统计: { 图片数: 0, 有关联型号: 0, 未关联型号: 0, 报价表数: 0, 新建缩略图: 0, 复用缩略图: 0, 解码失败: 0 },
      建议: ['先运行 npm run organize:library 整理资料库，再重建图片索引；确认 data/客服资料库 里的库存表没被移走或改名。'],
      索引路径: INDEX_FILE,
    };
  }
}

/** 后台启动一次重建，前端轮询 /v1/images/status；不阻塞 HTTP 请求 */
export function startImageBuild(force = false): boolean {
  if (buildState.running) return false;
  setImmediate(() => {
    void buildImageIndex({ force });
  });
  return true;
}

/* --------------------------- 查图 / 预览 --------------------------- */

function thumbDataUrl(entry: ImageEntry): string {
  try {
    const buf = fs.readFileSync(path.join(THUMB_DIR, entry.thumb));
    return `data:image/webp;base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

export interface MatchResult {
  ok: boolean;
  候选: ImageMatch[];
  hint: string;
  /** 同一张产品图在原表里挂了多行（型号 / 价格可能不同），必须人工核对 */
  重复图提示: string;
  /** 客户图带表格白边 / 边框，已额外用去边后的指纹比对 */
  已裁白边: boolean;
  变体数: number;
  索引图片数: number;
  索引时间: string;
  耗时毫秒: number;
}

export async function matchImage(buf: Buffer, limit = 5): Promise<MatchResult> {
  const t0 = Date.now();
  const index = getImageIndex();
  if (!index || !index.图片.length) {
    return {
      ok: false, 候选: [], 已裁白边: false, 重复图提示: '', 变体数: 0,
      索引图片数: 0, 索引时间: '', 耗时毫秒: Date.now() - t0,
      hint: '还没有图片索引。请点「重建图片索引」（或运行 npm run build:images），程序会读取当前库存表 / 报价表里的产品图。库存与产品图会随实际库存表变化、且当前库存表尚未更新，识别结果一律要人工核对原表对应行。',
    };
  }
  const query = await computeQueryFeatures(buf);
  const variants = query.variants;
  if (!variants.length) {
    return {
      ok: false, 候选: [], 已裁白边: false, 重复图提示: '', 变体数: 0,
      索引图片数: index.图片.length, 索引时间: index.生成时间, 耗时毫秒: Date.now() - t0,
      hint: '这张图片打不开或不是常见格式（png / jpg / webp），请另存后再试。',
    };
  }

  const scored = index.图片.map((e) => {
    // 库里每张图有两份指纹：原图 + 裁掉浅色底 / 表格边框后的版本。
    // 客户图带白边、库里图不带（或反过来）都能对上，取所有组合里的最高分。
    const indexFeatures = e.fn ? [e.f, e.fn] : [e.f];
    let best = 0;
    let d = 64;
    let p = 64;
    for (const v of variants) {
      for (const f of indexFeatures) {
        const s = similarity(v, f);
        if (s > best) {
          best = s;
          d = hamming(v.d, f.d);
          p = hamming(v.p, f.p);
        }
      }
    }
    return { e, score: best, d, p };
  });
  scored.sort((a, b) => b.score - a.score);

  // 已经有高置信命中时抬高门槛，别把 0.72~0.77 的「白底床图都长得像」噪声塞给客服；
  // 没把握时放宽到 0.72，多给几个候选让人自己比对。
  const topScore = scored[0]?.score ?? 0;
  const cutoff = topScore >= 0.88 ? 0.82 : 0.72;
  // 同一型号只保留最像的一张，避免前 5 名全被同一款的不同角度占满
  const seenSku = new Set<string>();
  const picked: typeof scored = [];
  for (const hit of scored) {
    if (hit.score < cutoff) break;
    const k = hit.e.型号 || hit.e.id;
    if (seenSku.has(k)) continue;
    seenSku.add(k);
    picked.push(hit);
    if (picked.length >= limit) break;
  }

  const 候选: ImageMatch[] = picked.map(({ e, score, d, p }) => {
    const conf = confidenceLabel(score);
    const priceText = e.价格 != null ? `${e.价格原文 || e.价格} ${e.币种 || 'CNY'}` : '原表这一行没填价格';
    return {
      id: e.id,
      相似度: Math.round(score * 1000) / 1000,
      置信度: conf,
      d距离: d,
      p距离: p,
      型号: e.型号,
      名称: e.名称,
      规格: e.规格,
      价格: e.价格,
      价格原文: e.价格原文,
      币种: e.币种,
      货期: e.货期,
      附加价格: e.附加价格,
      系列: e.系列,
      关联方式: e.关联方式,
      文件: e.文件,
      工作表: e.工作表,
      行号: e.行号,
      缩略图: thumbDataUrl(e),
      来源: e.来源 === '报价表内嵌' ? `嵌在「${e.文件}」里` : `独立图片「${e.文件}」`,
      hint: e.型号
        ? `型号 ${e.型号}，出厂价 ${priceText}${e.货期 ? `，货期 ${e.货期}` : ''}；来源：${e.文件} 工作表「${e.工作表}」第 ${e.行号} 行（${e.关联方式}）。这是表内价格，发给客户前必须人工核对原表对应行。`
        : e.名称
          ? `这张图已认出：${e.文件} 工作表「${e.工作表}」第 ${e.行号} 行，原表这一行写着「${e.名称}」，但没填型号和价格。报价一律写「待人工补充」，绝不从上下几行或其它表借价格；请人工打开原表核对这一行。`
          : `这张图没关联到型号，来源：${e.文件}${e.工作表 ? ` 工作表「${e.工作表}」第 ${e.行号} 行` : ''}。请人工打开原表确认，禁止据此报价。`,
    };
  });

  const top = 候选[0];
  let hint: string;
  if (!候选.length) {
    hint = '库里没有找到相似的图片，禁止猜型号或价格；请让客户补型号，或把照片裁到只剩单个产品后再试。';
  } else if (top.置信度 === '低') {
    hint = `只找到 ${候选.length} 个低相似度候选（最高 ${Math.round(top.相似度 * 100)}%），不足以确认型号，请人工比对缩略图后再决定，不要直接写价格。`;
  } else if (top.置信度 === '中') {
    hint = `找到 ${候选.length} 个候选，最高相似度 ${Math.round(top.相似度 * 100)}%，请人工确认是不是这一款再引用价格。`;
  } else {
    hint = `高置信命中：最像的是 ${top.型号 || '一张未关联型号的图'}，相似度 ${Math.round(top.相似度 * 100)}%，共 ${候选.length} 个候选；请照下面给的文件名 / 工作表 / 行号核对原表后再写进回复稿。`;
  }
  if (query.已裁白边) hint += '（这张客户图带白底 / 表格边框，已自动裁边后比对。）';

  // 同一张产品图有时被贴在原表好几行，且型号 / 价格不一样。这不是识别错误，
  // 但绝不能让客服以为只有一行：明确列出所有位置，要求打开原表确认。
  let 重复图提示 = '';
  if (top) {
    const hit = index.图片.find((x) => x.id === top.id);
    if (hit) {
      const same = index.图片.filter((x) =>
        x.id !== hit.id && hamming(x.f.d, hit.f.d) === 0 && hamming(x.f.p, hit.f.p) === 0);
      if (same.length) {
        const spots = [hit, ...same].slice(0, 5).map((x) =>
          `「${x.工作表 || x.文件}」第 ${x.行号} 行${x.型号 ? `（${x.型号}）` : ''}${x.价格 != null ? ` ${x.价格原文 || x.价格} ${x.币种 || ''}` : '（未填价）'}`).join('、');
        重复图提示 = `注意：同一张产品图在原表里出现在 ${same.length + 1} 行：${spots}。这些行的型号 / 价格可能不一样，请打开原表确认哪一行才是当前这批货，别直接引用候选里的价格。`;
        hint += ` ${重复图提示}`;
      }
    }
  }

  return {
    ok: !!候选.length,
    候选,
    hint,
    重复图提示,
    已裁白边: query.已裁白边,
    变体数: variants.length,
    索引图片数: index.图片.length,
    索引时间: index.生成时间,
    耗时毫秒: Date.now() - t0,
  };
}

/** hover 预览：优先给有型号的图，缩略图直接内嵌 dataURL，绕开 <img> 带不了鉴权头的问题 */
export function listPreview(offset = 0, limit = 24): {
  ok: boolean;
  总数: number;
  有型号: number;
  索引时间: string;
  items: Array<{ id: string; 型号: string; 名称: string; 价格: number | null; 币种: string; 文件: string; 工作表: string; 行号: number; 缩略图: string }>;
  hint: string;
} {
  const index = getImageIndex();
  if (!index || !index.图片.length) {
    return {
      ok: false, 总数: 0, 有型号: 0, 索引时间: '', items: [],
      hint: '还没有图片索引。点右上角「重建图片索引」即可从当前库存表 / 报价表读取产品图；库存与产品图会随实际库存表变化，当前库存表尚未更新，请人工核对。',
    };
  }
  const withSku = index.图片.filter((e) => !!e.型号);
  const items = withSku.slice(offset, offset + limit).map((e) => ({
    id: e.id, 型号: e.型号, 名称: e.名称, 价格: e.价格, 币种: e.币种,
    文件: e.文件, 工作表: e.工作表, 行号: e.行号, 缩略图: thumbDataUrl(e),
  }));
  return {
    ok: true,
    总数: index.图片.length,
    有型号: withSku.length,
    索引时间: index.生成时间,
    items,
    hint: '',
  };
}

export function imageStatus(): Record<string, unknown> {
  const index = getImageIndex();
  return {
    ok: !!index,
    已建索引: !!index,
    ...(index ? {
      统计: index.统计, 特征版本: index.特征版本 ?? 1,
      去白边指纹数: index.图片.filter((e) => !!e.fn).length,
      生成时间: index.生成时间, 建议: index.建议,
    } : {}),
    构建中: buildState.running,
    构建状态: buildState,
  };
}

/* -------------------- 按需取原图（给客户发图用） -------------------- */

export interface OriginalImage {
  ok: boolean;
  hint: string;
  /** dataURL：可直接贴进 <img>、复制进剪贴板或另存为文件 */
  图片: string;
  文件名: string;
  mime: string;
  字节数: number;
  宽: number;
  高: number;
  id: string;
  型号: string;
  名称: string;
  文件: string;
  工作表: string;
  行号: number;
  价格: number | null;
  价格原文: string;
  币种: string;
  货期: string;
  来源: string;
  已缩放: boolean;
}

const ORIGINAL_MAX_BYTES = 10 * 1024 * 1024;
const SAFE_NAME = /[\\/:*?"<>|\r\n]/g;

function mimeOf(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return '';
}

/**
 * 把索引里的一张产品图还原成「可以发给客户的原图」。
 * 只读：报价表内嵌图直接从 xlsx 的 zip 条目里解出来，独立图片直接读文件；
 * 不写、不改名、不移动任何用户资料，也不缓存到资料目录之外。
 * 超过 10MB / sharp 不认的格式会等比缩到 1600px 转 PNG，避免前端 dataURL 过大。
 */
export async function getOriginalImage(id: string): Promise<OriginalImage> {
  const base = (e: ImageEntry | undefined): OriginalImage => ({
    ok: false, hint: '', 图片: '', 文件名: '', mime: '', 字节数: 0, 宽: 0, 高: 0,
    id: String(id ?? ''), 型号: e?.型号 ?? '', 名称: e?.名称 ?? '',
    文件: e?.文件 ?? '', 工作表: e?.工作表 ?? '', 行号: e?.行号 ?? 0,
    价格: e?.价格 ?? null, 价格原文: e?.价格原文 ?? '', 币种: e?.币种 ?? '',
    货期: e?.货期 ?? '',
    来源: e
      ? (e.容器 === 'xls' ? `「${e.文件}」的单元格图片` : e.来源 === '报价表内嵌' ? `嵌在「${e.文件}」里` : `独立图片「${e.文件}」`)
      : '',
    已缩放: false,
  });
  const index = getImageIndex();
  const e = index?.图片.find((x) => x.id === id);
  if (!e) {
    const r = base(undefined);
    r.hint = '图片索引里没有这一张（可能刚重建过），请重新点一次图片匹配。';
    return r;
  }
  const out = base(e);
  out.宽 = e.原图宽 || 0;
  out.高 = e.原图高 || 0;
  out.文件名 = `${(e.型号 || e.名称 || '产品图').replace(SAFE_NAME, '_').slice(0, 48)}_${e.id.slice(0, 8)}`;

  let buf: Buffer;
  try {
    const abs = path.join(cfg.kbRoot, e.文件);
    if (!fs.existsSync(abs)) {
      out.hint = `找不到来源文件「${e.文件}」，请确认资料文件夹里的报价表没被移走。`;
      return out;
    }
    if (e.容器 === 'xls') {
      // 老式 .xls 的单元格图片在 ETCellImageData 流里，不在文件本身的 zip 条目中
      buf = readXlsEmbeddedMedia(abs, e.media, MEDIA_LIMIT);
    } else if (e.来源 === '报价表内嵌') {
      const ent = listZipEntries(abs).find((x) => x.name === e.media);
      if (!ent) {
        out.hint = `报价表里找不到这张内嵌图（${e.media}），可能是原表被改过，建议重建图片索引。`;
        return out;
      }
      buf = readZipEntry(abs, ent, MEDIA_LIMIT);
    } else {
      buf = fs.readFileSync(abs);
    }
  } catch (err) {
    out.hint = `读取原图没成功：${(err as Error).message}。原始资料没有被改动。`;
    return out;
  }
  if (!buf || buf.length < 64) {
    out.hint = '这张原图是空的或读不出来，建议重建图片索引。';
    return out;
  }

  let mime = mimeOf(e.media || e.文件);
  let payload = buf;
  if (!mime || buf.length > ORIGINAL_MAX_BYTES) {
    try {
      payload = await sharp(buf, { failOn: 'none', limitInputPixels: 120_000_000 })
        .rotate()
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
      mime = 'image/png';
      out.已缩放 = true;
      out.宽 = 0;
      out.高 = 0;
    } catch (err) {
      out.hint = `这张图片格式解不开（${(err as Error).message}），请改用缩略图或打开来源文件另存。`;
      return out;
    }
  }
  out.ok = true;
  out.mime = mime;
  out.字节数 = payload.length;
  out.图片 = `data:${mime};base64,${payload.toString('base64')}`;
  out.文件名 += mime === 'image/png' ? '.png' : mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.gif';
  out.hint = out.已缩放
    ? `原图较大，已等比缩到 1600px 并转成 PNG（${Math.round(payload.length / 1024)} KB）。`
    : `已从「${e.文件}」${e.行号 ? ` 第 ${e.行号} 行` : ''}只读取出原图（${Math.round(payload.length / 1024)} KB）。`;
  out.hint += '表内价格是出厂价 / 内部价，发给客户前请人工核对来源行；程序不会自动发送消息。';
  return out;
}
