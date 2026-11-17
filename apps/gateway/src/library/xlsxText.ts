import fs from 'node:fs';
import * as CFB from 'cfb';
import XLSX from 'xlsx';
import { listZipEntries, readZipEntry } from './zipReader.js';

/**
 * 从表格里只取「文字」，不碰任何图片。
 * .xlsx / .xlsm 直接读 OOXML 的 XML（不依赖 xlsx 库的全量解压）；
 * .xls（OLE2 / BIFF8）只抽 Workbook 文字流，几百 MB 的单元格图片流一个字节都不读。
 * 因此两种格式对几百 MB 的图文库存表都很快，原始文件一律只读。
 */

export interface SheetData {
  name: string;
  file: string; // zip 内路径，例如 xl/worksheets/sheet1.xml
  rows: string[][]; // 稀疏行：下标 = Excel 列序号，空单元格为 ''
}

function decodeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(attrs: string, key: string): string {
  const m = new RegExp(`\\b${key}="([^"]*)"`).exec(attrs);
  return m ? decodeXml(m[1]) : '';
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const t of m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += decodeXml(t[1]);
    out.push(text);
  }
  return out;
}

function colIndex(ref: string): number {
  const m = /^([A-Z]+)/i.exec(ref);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function cellValue(attrs: string, inner: string, shared: string[]): string {
  const type = attr(attrs, 't');
  if (type === 'inlineStr') {
    let text = '';
    for (const t of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += decodeXml(t[1]);
    return text;
  }
  const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
  if (type === 's') {
    const i = Number(v);
    return Number.isInteger(i) && i >= 0 && i < shared.length ? shared[i] : '';
  }
  if (type === 'b') return v === '1' ? 'TRUE' : 'FALSE';
  return decodeXml(v);
}

export interface ParsedRow {
  row: number; // Excel 1-based 行号
  cells: string[];
}

function parseSheet(xml: string, shared: string[]): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const rowRe = /<row\b([^>]*?)\/>|<row\b([^>]*?)>([\s\S]*?)<\/row>/g;
  let autoRow = 0;
  for (const rm of xml.matchAll(rowRe)) {
    const attrs = rm[1] ?? rm[2] ?? '';
    const inner = rm[3] ?? '';
    autoRow++;
    const rowNo = Number(attr(attrs, 'r')) || autoRow;
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
    for (const cm of inner.matchAll(cellRe)) {
      const cAttrs = cm[1] ?? cm[2] ?? '';
      const cInner = cm[3] ?? '';
      const idx = colIndex(attr(cAttrs, 'r'));
      if (idx < 0 || idx > 120) continue;
      cells[idx] = cellValue(cAttrs, cInner, shared).trim();
    }
    rows.push({ row: rowNo, cells });
  }
  return rows;
}

/** 读出工作簿里所有工作表的文字内容 */
export function readXlsxText(file: string): SheetData[] {
  const entries = listZipEntries(file);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const read = (name: string): string => {
    const e = byName.get(name);
    if (!e) return '';
    try {
      return readZipEntry(file, e, 48 * 1024 * 1024).toString('utf8');
    } catch {
      return '';
    }
  };

  const shared = parseSharedStrings(read('xl/sharedStrings.xml'));
  const workbook = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');

  // rId -> 真实 sheet 路径
  const targetById = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(m[1], 'Id');
    let target = attr(m[1], 'Target');
    if (!id || !target) continue;
    target = target.replace(/^\//, '');
    if (!target.startsWith('xl/')) target = 'xl/' + target.replace(/^\.\//, '');
    targetById.set(id, target);
  }

  const declared: Array<{ name: string; file: string }> = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const name = attr(m[1], 'name') || `工作表${declared.length + 1}`;
    const rid = attr(m[1], 'r:id') || attr(m[1], 'id');
    const f = targetById.get(rid);
    if (f) declared.push({ name, file: f });
  }

  // 关系表缺失时按文件序号兜底，保证老文件也能读
  const sheetFiles = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => (Number(/sheet(\d+)/i.exec(a)?.[1] ?? 0)) - (Number(/sheet(\d+)/i.exec(b)?.[1] ?? 0)));
  if (declared.length === 0) {
    for (const f of sheetFiles) declared.push({ name: f.replace(/^.*\//, '').replace(/\.xml$/, ''), file: f });
  }

  const out: SheetData[] = [];
  for (const d of declared) {
    const xml = read(d.file);
    if (!xml) continue;
    out.push({ name: d.name, file: d.file, rows: parseSheet(xml, shared).map((r) => r.cells) });
  }
  return out;
}

/** 需要保留真实行号时用这个版本 */
export function readXlsxTextWithRows(file: string): Array<{ name: string; rows: ParsedRow[] }> {
  const entries = listZipEntries(file);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const read = (name: string): string => {
    const e = byName.get(name);
    if (!e) return '';
    try {
      return readZipEntry(file, e, 48 * 1024 * 1024).toString('utf8');
    } catch {
      return '';
    }
  };
  const shared = parseSharedStrings(read('xl/sharedStrings.xml'));
  const workbook = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');
  const targetById = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(m[1], 'Id');
    let target = attr(m[1], 'Target');
    if (!id || !target) continue;
    target = target.replace(/^\//, '');
    if (!target.startsWith('xl/')) target = 'xl/' + target.replace(/^\.\//, '');
    targetById.set(id, target);
  }
  const declared: Array<{ name: string; file: string }> = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const name = attr(m[1], 'name') || `工作表${declared.length + 1}`;
    const rid = attr(m[1], 'r:id') || attr(m[1], 'id');
    const f = targetById.get(rid);
    if (f) declared.push({ name, file: f });
  }
  const sheetFiles = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => Number(/sheet(\d+)/i.exec(a)?.[1] ?? 0) - Number(/sheet(\d+)/i.exec(b)?.[1] ?? 0));
  if (declared.length === 0) {
    for (const f of sheetFiles) declared.push({ name: f.replace(/^.*\//, '').replace(/\.xml$/, ''), file: f });
  }
  return declared
    .map((d) => {
      const xml = read(d.file);
      return xml ? { name: d.name, rows: parseSheet(xml, shared) } : null;
    })
    .filter((x): x is { name: string; rows: ParsedRow[] } => x !== null);
}

export interface XlsReadResult {
  sheets: Array<{ name: string; rows: ParsedRow[] }>;
  /** WPS 单元格图片（=DISPIMG）的个数，只统计，不读图片数据 */
  cellImages: number;
  workbookBytes: number;
}

/**
 * 老式 .xls 只读解析（WPS / Excel 97-2003）。
 *
 * 关键点：这类库存表把产品照片放在 `ETCellImageData` 流里，实测单文件可达 405MB。
 * 先用 CFB 找到 Workbook 流，再把它单独包成一个最小 CFB 交给 SheetJS，
 * 图片流完全不进入解析器。449MB 的表实测约 700ms、36MB 堆内存。
 *
 * 型号列常常是一张图（=DISPIMG("ID_…",1)）而不是文字：这里把它计成图片、值置空，
 * 避免把公式当成型号写进索引；型号再由索引器回退到「产品类型 / 名称」列。
 */
export function readXlsTextWithRows(file: string): XlsReadResult {
  const cfb = CFB.read(fs.readFileSync(file), { type: 'buffer' });
  const stream = CFB.find(cfb, 'Workbook') ?? CFB.find(cfb, 'Book');
  if (!stream?.content) throw new Error('找不到 Workbook 流，可能不是有效的 .xls');

  const workbook = Buffer.from(stream.content as Uint8Array);
  const mini = CFB.utils.cfb_new();
  CFB.utils.cfb_add(mini, 'Workbook', workbook);
  const wrapped = Buffer.from(CFB.write(mini, { type: 'buffer' }) as Uint8Array);
  const wb = XLSX.read(wrapped, { type: 'buffer', cellFormula: true, cellHTML: false });

  let cellImages = 0;
  const sheets = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const ref = ws?.['!ref'];
    if (!ref) return { name, rows: [] as ParsedRow[] };
    const range = XLSX.utils.decode_range(ref);
    const lastRow = Math.min(range.e.r, 20000);
    const lastCol = Math.min(range.e.c, 120);
    const rows: ParsedRow[] = [];
    for (let r = range.s.r; r <= lastRow; r++) {
      const cells: string[] = [];
      let hasValue = false;
      for (let c = range.s.c; c <= lastCol; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        let v = cell ? (cell.f ? `=${cell.f}` : String(cell.v ?? '')) : '';
        if (/^=DISPIMG\(/i.test(v)) {
          cellImages++;
          v = '';
        }
        v = v.trim();
        cells[c - range.s.c] = v;
        if (v) hasValue = true;
      }
      if (hasValue) rows.push({ row: r + 1, cells });
    }
    return { name, rows };
  });
  return { sheets, cellImages, workbookBytes: workbook.length };
}
