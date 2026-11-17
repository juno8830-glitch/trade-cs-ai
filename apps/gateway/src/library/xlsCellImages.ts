import fs from 'node:fs';
import path from 'node:path';
import * as CFB from 'cfb';
import XLSX from 'xlsx';
import { listZipEntriesFromBuffer, readZipEntryFromBuffer, type ZipEntry } from './zipReader.js';

/**
 * 老式 .xls（WPS）里「贴进单元格」的产品图。
 *
 * 这类图不放在 xl/drawings/ 锚点里，而是：
 *   OLE2 流 ETCellImageData  →  其实是一整段 ZIP
 *     xl/cellImages.xml           : <xdr:cNvPr name="ID_xxx"> ↔ <a:blip r:embed="rIdN">
 *     xl/_rels/cellImages.xml.rels: rIdN → media/imageN.png
 *     xl/media/imageN.png         : 真实图片
 *   Workbook 流                    : 单元格公式 =DISPIMG("ID_xxx",1) → 工作表 + 行号 + 列
 *
 * 所以「客户发的图 → 型号 / 价格」的链路是齐的：
 *   DISPIMG 所在单元格的 Excel 行号 → 资料索引.json 里同一文件 / 工作表 / 行号的报价行。
 *
 * 全程只读原始 .xls；图片流按需解压，不落盘、不改动任何用户文件。
 */

export interface XlsImageAnchor {
  media: string; // zip 内路径，例如 xl/media/image3.png
  sheet: string;
  row: number; // Excel 1-based 行号
  col: number; // 0-based 列号
  seq: number;
  bytes: number;
}

export interface XlsImageTable {
  anchors: XlsImageAnchor[];
  /** 按 zip 内路径取原图字节；超过 limit 会抛错，避免把异常大图读进内存 */
  read: (media: string, limit: number) => Buffer;
}

interface CellImageZip {
  buf: Buffer;
  byName: Map<string, ZipEntry>;
}

function attr(attrs: string, key: string): string {
  const m = new RegExp(`\\b${key}="([^"]*)"`).exec(attrs);
  return m ? m[1] : '';
}

/** rels 里的 Target 相对「关系文件所在目录去掉 _rels」；绝对路径则直接当 zip 内路径 */
function resolveTarget(target: string): string {
  const t = target.replace(/\\/g, '/');
  if (t.startsWith('/')) return path.posix.normalize(t.slice(1));
  return path.posix.normalize(path.posix.join('xl', t));
}

/** 只读抽出 ETCellImageData 这段 zip（不解析 Workbook，给「还原原图」用） */
function loadCellImageZip(file: string): CellImageZip {
  const cfb = CFB.read(fs.readFileSync(file), { type: 'buffer' });
  const candidate = cfb.FileIndex.find((e) => /ETCellImageData|cellimage/i.test(e.name));
  const stream = candidate ? CFB.find(cfb, candidate.name) : CFB.find(cfb, 'ETCellImageData');
  if (!stream?.content) throw new Error('这个 .xls 里没有 ETCellImageData 图片流');
  const buf = Buffer.from(stream.content as Uint8Array);
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('ETCellImageData 不是可识别的 zip 图片包');
  }
  const entries = listZipEntriesFromBuffer(buf);
  return { buf, byName: new Map(entries.map((e) => [e.name, e])) };
}

/** 只解压 ETCellImageData 里的一张原图，供 /v1/images/original 使用 */
export function readXlsEmbeddedMedia(file: string, media: string, limit: number): Buffer {
  const zip = loadCellImageZip(file);
  const entry = zip.byName.get(media);
  if (!entry) throw new Error(`图片流里找不到 ${media}`);
  return readZipEntryFromBuffer(zip.buf, entry, limit);
}

/** 从 Workbook 流里找出所有 =DISPIMG("ID_…") 单元格，得到图片所在的行 / 列 */
function collectDispimgCells(file: string): Array<{ id: string; sheet: string; row: number; col: number }> {
  const cfb = CFB.read(fs.readFileSync(file), { type: 'buffer' });
  const ws = CFB.find(cfb, 'Workbook') ?? CFB.find(cfb, 'Book');
  if (!ws?.content) throw new Error('找不到 Workbook 流，可能不是有效的 .xls');
  const mini = CFB.utils.cfb_new();
  CFB.utils.cfb_add(mini, 'Workbook', Buffer.from(ws.content as Uint8Array));
  const wrapped = Buffer.from(CFB.write(mini, { type: 'buffer' }) as Uint8Array);
  const wb = XLSX.read(wrapped, { type: 'buffer', cellFormula: true, cellHTML: false });

  const out: Array<{ id: string; sheet: string; row: number; col: number }> = [];
  for (const sheet of wb.SheetNames) {
    const wsData = wb.Sheets[sheet];
    if (!wsData) continue;
    for (const addr of Object.keys(wsData)) {
      if (addr.startsWith('!')) continue;
      const cell = wsData[addr];
      const f = cell?.f ? String(cell.f) : '';
      const id = /DISPIMG\(\s*"?([^")\s,]+)"?/i.exec(f)?.[1] ?? '';
      if (!id) continue;
      const pos = XLSX.utils.decode_cell(addr);
      out.push({ id, sheet, row: pos.r + 1, col: pos.c });
    }
  }
  return out;
}

/**
 * 解析一个 .xls 的全部单元格图片锚点。
 * 只返回「图片 ID 与 DISPIMG 单元格都对得上」的图；对不上就跳过，绝不猜位置。
 */
export function parseXlsCellImages(file: string): XlsImageTable {
  const zip = loadCellImageZip(file);

  const cellImagesEntry = zip.byName.get('xl/cellImages.xml');
  const relsEntry = zip.byName.get('xl/_rels/cellImages.xml.rels');
  if (!cellImagesEntry || !relsEntry) throw new Error('图片包里缺少 cellImages.xml 或它的 rels');

  const cellImagesXml = readZipEntryFromBuffer(zip.buf, cellImagesEntry).toString('utf8');
  const relsXml = readZipEntryFromBuffer(zip.buf, relsEntry).toString('utf8');

  const rIdToMedia = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) rIdToMedia.set(id, resolveTarget(target));
  }

  const idToMedia = new Map<string, string>();
  for (const m of cellImagesXml.matchAll(/<etc:cellImage\b[^>]*>([\s\S]*?)<\/etc:cellImage>/g)) {
    const block = m[1];
    const id = /<xdr:cNvPr\b[^>]*\bname="([^"]+)"/.exec(block)?.[1] ?? '';
    const rId = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(block)?.[1] ?? '';
    const media = rIdToMedia.get(rId);
    if (id && media && zip.byName.has(media)) idToMedia.set(id, media);
  }

  const cells = collectDispimgCells(file);
  const anchors: XlsImageAnchor[] = [];
  let seq = 0;
  for (const c of cells) {
    const media = idToMedia.get(c.id);
    if (!media) continue;
    const entry = zip.byName.get(media);
    if (!entry || entry.size <= 0) continue;
    anchors.push({ media, sheet: c.sheet, row: c.row, col: c.col, seq: seq++, bytes: entry.size });
  }
  anchors.sort((a, b) => a.sheet.localeCompare(b.sheet) || a.row - b.row || a.col - b.col);

  return {
    anchors,
    read: (media: string, limit: number): Buffer => {
      const entry = zip.byName.get(media);
      if (!entry) throw new Error(`图片流里找不到 ${media}`);
      return readZipEntryFromBuffer(zip.buf, entry, limit);
    },
  };
}
