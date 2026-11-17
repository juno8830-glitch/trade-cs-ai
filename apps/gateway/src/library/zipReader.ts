import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * 只读 ZIP 解析器（零依赖）。
 *
 * 为什么不用 xlsx 库直接 readFile？
 *   用户的真实库存表里嵌了大量产品图片，单文件 400MB+。
 *   XLSX.readFile 会把整个包解压进内存（可能几个 GB），轻则几十秒卡住，重则直接崩。
 *   而表格文字其实只有 xl/sharedStrings.xml + xl/worksheets/sheetN.xml，一共约 1MB。
 *   这里只读 ZIP 中央目录，挑出需要的几个小条目解压，跳过 xl/media/* 里的所有图片，
 *   所以几百 MB 的表也能在 1 秒内读完，内存占用只有几 MB。
 *
 * 全程只读，不会修改用户的任何原始文件。
 */

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const u16 = (b: Buffer, o: number) => b.readUInt16LE(o);
const u32 = (b: Buffer, o: number) => b.readUInt32LE(o);
const u64 = (b: Buffer, o: number) => Number(b.readBigUInt64LE(o));

function readAt(fd: number, length: number, position: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, position + done);
    if (n <= 0) break;
    done += n;
  }
  return done === length ? buf : buf.subarray(0, done);
}

/** 从 extra field 里补出 ZIP64 的真实大小 / 偏移 */
function fixZip64(extra: Buffer, e: ZipEntry, needSize: boolean, needComp: boolean, needOffset: boolean): void {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = u16(extra, p);
    const len = u16(extra, p + 2);
    if (id === 0x0001) {
      let v = p + 4;
      if (needSize && v + 8 <= p + 4 + len) { e.size = u64(extra, v); v += 8; }
      if (needComp && v + 8 <= p + 4 + len) { e.compressedSize = u64(extra, v); v += 8; }
      if (needOffset && v + 8 <= p + 4 + len) { e.localOffset = u64(extra, v); v += 8; }
      return;
    }
    p += 4 + len;
  }
}

/** 随机读一段字节：磁盘文件走 fd，内存里的 zip 流走 Buffer.subarray */
type ZipRead = (length: number, position: number) => Buffer;

/** 只读中央目录，列出 zip 内的条目（不解压内容） */
function parseZipEntries(read: ZipRead, size: number): ZipEntry[] {
  const tailLen = Math.min(size, 66000);
  const tail = read(tailLen, size - tailLen);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === SIG_EOCD && i + 22 + u16(tail, i + 20) === tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx / zip 文件（找不到文件尾）');

  let total = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);

  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    if (eocd >= 20 && u32(tail, eocd - 20) === SIG_ZIP64_LOCATOR) {
      const z64Pos = u64(tail, eocd - 20 + 8);
      const z64 = read(56, z64Pos);
      if (u32(z64, 0) === SIG_ZIP64_EOCD) {
        total = Number(z64.readBigUInt64LE(32));
        cdSize = Number(z64.readBigUInt64LE(40));
        cdOffset = Number(z64.readBigUInt64LE(48));
      }
    }
  }

  const cd = read(cdSize, cdOffset);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < total && p + 46 <= cd.length; i++) {
    if (u32(cd, p) !== SIG_CENTRAL) break;
    const method = u16(cd, p + 10);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    const e: ZipEntry = {
      name: cd.toString('utf8', p + 46, p + 46 + nameLen),
      method,
      compressedSize: u32(cd, p + 20),
      size: u32(cd, p + 24),
      localOffset: u32(cd, p + 42),
    };
    const needSize = e.size === 0xffffffff;
    const needComp = e.compressedSize === 0xffffffff;
    const needOffset = e.localOffset === 0xffffffff;
    if (needSize || needComp || needOffset) {
      fixZip64(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), e, needSize, needComp, needOffset);
    }
    entries.push(e);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function listZipEntries(file: string): ZipEntry[] {
  const fd = fs.openSync(file, 'r');
  try {
    return parseZipEntries((length, position) => readAt(fd, length, position), fs.fstatSync(fd).size);
  } finally {
    fs.closeSync(fd);
  }
}

/** 老式 .xls 的 ETCellImageData 流本身就是一段 zip，已经读进内存，不需要落盘 */
export function listZipEntriesFromBuffer(buf: Buffer): ZipEntry[] {
  return parseZipEntries((length, position) => buf.subarray(position, Math.min(buf.length, position + length)), buf.length);
}

/** 只解压指定的一个条目；大于 limit 的条目一律拒绝（防止图片被读进内存） */
function extractZipEntry(read: ZipRead, entry: ZipEntry, limit: number): Buffer {
  if (entry.size > limit) throw new Error(`条目 ${entry.name} 超过安全上限，已跳过`);
  const local = read(30, entry.localOffset);
  if (u32(local, 0) !== SIG_LOCAL) throw new Error(`条目 ${entry.name} 的头部损坏`);
  const nameLen = u16(local, 26);
  const extraLen = u16(local, 28);
  const raw = read(entry.compressedSize, entry.localOffset + 30 + nameLen + extraLen);
  if (entry.method === 0) return raw; // 未压缩
  if (entry.method === 8) return zlib.inflateRawSync(raw); // deflate
  throw new Error(`不支持的压缩方式 ${entry.method}`);
}

export function readZipEntry(file: string, entry: ZipEntry, limit = 32 * 1024 * 1024): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    return extractZipEntry((length, position) => readAt(fd, length, position), entry, limit);
  } finally {
    fs.closeSync(fd);
  }
}

export function readZipEntryFromBuffer(buf: Buffer, entry: ZipEntry, limit = 32 * 1024 * 1024): Buffer {
  return extractZipEntry((length, position) => buf.subarray(position, Math.min(buf.length, position + length)), entry, limit);
}

/** 按名字批量读取若干小条目，找不到就跳过（不同版本的 Excel 目录名略有差异） */
export function readZipTexts(file: string, names: string[]): Map<string, string> {
  const wanted = new Set(names);
  const out = new Map<string, string>();
  for (const e of listZipEntries(file)) {
    if (!wanted.has(e.name)) continue;
    try {
      out.set(e.name, readZipEntry(file, e).toString('utf8'));
    } catch {
      // 单个条目坏了不影响其他条目
    }
  }
  return out;
}

/** 顺手统计内嵌图片数量，写进中文清单，让用户知道图片确实在表里 */
export function countEmbeddedImages(file: string): number {
  try {
    return listZipEntries(file).filter((e) => /^xl\/media\//i.test(e.name)).length;
  } catch {
    return 0;
  }
}
