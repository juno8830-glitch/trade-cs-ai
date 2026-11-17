import sharp from 'sharp';

/**
 * 图片指纹（本地计算，不联网、不调视觉大模型）
 *
 * 为什么用指纹而不是让 AI「看图猜型号」：
 *   客户发来的多半就是报价表里的产品图（或转发时被压缩 / 加了水印 / 截了边），
 *   同一张图用感知哈希比对是毫秒级、可复现、也不会凭空编一个型号出来；
 *   视觉模型要联网、要等几秒、还可能把型号 A 说成型号 B。
 *
 * 三重特征，兼顾「准」和「抗压缩」：
 *   dHash  9x8   —— 对缩放 / JPEG 压缩 / 轻微水印稳
 *   pHash 32x32 DCT —— 对亮度调整 / 对比度 / 二次压缩稳
 *   4x4 网格平均色 —— 把「同为白底床图但款式不同」的候选压下去
 *   宽高比         —— 惩罚整张表格截图 / 聊天界面长图
 */

export interface ImageFeatures {
  d: string; // dHash，16 位十六进制 = 64 bit
  p: string; // pHash，16 位十六进制 = 64 bit
  c: number[]; // 4x4 网格平均 RGB，48 个 0..255
  r: number; // 宽高比
  w: number;
  h: number;
}

const SHARP_OPTS = { failOn: 'none' as const, limitInputPixels: 120_000_000 };
const THUMB_SIZE = 256;

/** 64 个 0/1 压成 16 个十六进制字符 */
function bitsToHex(bits: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < 64; i += 4) {
    const v = (bits[i] ? 8 : 0) | (bits[i + 1] ? 4 : 0) | (bits[i + 2] ? 2 : 0) | (bits[i + 3] ? 1 : 0);
    out += v.toString(16);
  }
  return out;
}

function pop16(x: number): number {
  x = x - ((x >>> 1) & 0x5555);
  x = (x & 0x3333) + ((x >>> 2) & 0x3333);
  x = (x + (x >>> 4)) & 0x0f0f;
  return (x + (x >>> 8)) & 0x1f;
}

/** 两个 64bit 指纹的汉明距离（0 = 完全一致，64 = 完全无关） */
export function hamming(a: string, b: string): number {
  if (!a || !b || a.length !== 16 || b.length !== 16) return 64;
  let n = 0;
  for (let i = 0; i < 16; i += 4) {
    n += pop16(parseInt(a.slice(i, i + 4), 16) ^ parseInt(b.slice(i, i + 4), 16));
  }
  return n;
}

/** 面积平均下采样成灰度网格，避免直接取点造成的锯齿敏感 */
function grayGrid(raw: Buffer, w: number, h: number, ch: number, tw: number, th: number): Float64Array {
  const out = new Float64Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * h) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * w) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / tw));
      let s = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * ch;
          s += 0.299 * raw[i] + 0.587 * raw[i + 1] + 0.114 * raw[i + 2];
          n++;
        }
      }
      out[ty * tw + tx] = n ? s / n : 0;
    }
  }
  return out;
}

function colorGrid(raw: Buffer, w: number, h: number, ch: number): number[] {
  const out: number[] = [];
  const tw = 4;
  const th = 4;
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * h) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * w) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / tw));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * ch;
          r += raw[i];
          g += raw[i + 1];
          b += raw[i + 2];
          n++;
        }
      }
      out.push(Math.round(n ? r / n : 0), Math.round(n ? g / n : 0), Math.round(n ? b / n : 0));
    }
  }
  return out;
}

// 32x32 DCT 的 8 个低频基，预计算一次
const DCT_N = 32;
const BASIS: Float64Array[] = [];
for (let u = 0; u < 8; u++) {
  const row = new Float64Array(DCT_N);
  const cu = u === 0 ? Math.sqrt(1 / DCT_N) : Math.sqrt(2 / DCT_N);
  for (let x = 0; x < DCT_N; x++) row[x] = cu * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * DCT_N));
  BASIS.push(row);
}

function pHashFromGrid(g: Float64Array): string {
  // 先沿 x 做一维 DCT，再沿 y 做，取左上 8x8 低频
  const tmp = new Float64Array(8 * DCT_N);
  for (let y = 0; y < DCT_N; y++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let x = 0; x < DCT_N; x++) s += g[y * DCT_N + x] * BASIS[v][x];
      tmp[v * DCT_N + y] = s;
    }
  }
  const coeff = new Float64Array(64);
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < DCT_N; y++) s += tmp[v * DCT_N + y] * BASIS[u][y];
      coeff[v * 8 + u] = s;
    }
  }
  const sorted = Array.from(coeff).sort((a, b) => a - b);
  const median = (sorted[31] + sorted[32]) / 2;
  const bits = new Uint8Array(64);
  for (let i = 0; i < 64; i++) bits[i] = coeff[i] > median ? 1 : 0;
  return bitsToHex(bits);
}

function dHashFromGrid(g: Float64Array, tw = 9, th = 8): string {
  const bits = new Uint8Array(64);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw - 1; x++) bits[y * 8 + x] = g[y * tw + x] > g[y * tw + x + 1] ? 1 : 0;
  }
  return bitsToHex(bits);
}

/** 从已解码的 RGB 小图直接算特征（建索引和查图共用同一套算法，保证可比） */
export function featuresFromRaw(data: Buffer, w: number, h: number, ch: number): ImageFeatures {
  const g9 = grayGrid(data, w, h, ch, 9, 8);
  const g32 = grayGrid(data, w, h, ch, 32, 32);
  return {
    d: dHashFromGrid(g9),
    p: pHashFromGrid(g32),
    c: colorGrid(data, w, h, ch),
    r: w / Math.max(1, h),
    w,
    h,
  };
}

export interface DecodedImage {
  features: ImageFeatures;
  thumb: Buffer; // webp 缩略图，可直接落盘或转 dataURL
  width: number;
  height: number;
}

/** 已经解成 256px 小图的 RGB 像素，裁剪变体都在这上面算，不重复解码大图 */
export interface RawImage {
  data: Buffer;
  w: number;
  h: number;
  ch: number;
}

export async function decodeToRaw(buf: Buffer): Promise<RawImage | null> {
  try {
    const { data, info } = await sharp(buf, SHARP_OPTS)
      .rotate()
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height || info.channels < 3) return null;
    return { data, w: info.width, h: info.height, ch: info.channels };
  } catch {
    return null;
  }
}

/**
 * 一次解码同时产出「特征 + 缩略图」。
 * 只解到 256px 小图，几百 MB 的 xlsx 里 25MB 一张的产品图也不会把内存撑爆。
 */
export async function decodeImage(buf: Buffer): Promise<DecodedImage | null> {
  try {
    const meta = await sharp(buf, SHARP_OPTS).metadata();
    const raw = await decodeToRaw(buf);
    if (!raw) return null;
    const features = featuresFromRaw(raw.data, raw.w, raw.h, raw.ch);
    const channels = (raw.ch >= 4 ? 4 : 3) as 3 | 4;
    const thumb = await sharp(raw.data, { raw: { width: raw.w, height: raw.h, channels } })
      .webp({ quality: 72, effort: 2 })
      .toBuffer();
    return { features, thumb, width: meta.width ?? raw.w, height: meta.height ?? raw.h };
  } catch {
    return null;
  }
}

/* ------------------------- 表格白边 / 边框裁切 ------------------------- */

export interface ContentBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

const lum = (data: Buffer, i: number): number =>
  0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

/**
 * 找「浅色底 + 表格边框」里真正的产品区域。
 *
 * 客户常直接从 Excel / WPS 单元格里复制图片，粘过来会带一圈白底，甚至带着
 * 单元格网格线 / 选中框；sharp.trim() 只看左上角一个像素，遇到边框线就立刻
 * 停住，白边一点都裁不掉。这里改成在 256px 小图上做：
 *   ① 从四边采样，取占比最大的「浅色近中性」颜色当底色（白 / 米白 / 浅灰都行）；
 *   ② 逐行逐列从外往里扫，纯底色行算留白，整行近乎纯色的细线算表格边框跳过；
 *   ③ 碰到真正有内容的行就停，得到产品内容框。
 * 只有至少一边确实裁掉了 ≥6% 才返回，避免把白色产品本身误裁掉。
 */
export function findContentBox(raw: RawImage): ContentBox | null {
  const { data, w, h, ch } = raw;
  if (w < 48 || h < 48) return null;

  // ① 四边采样定底色：边框线只占最外面一两行，白底仍是多数
  const strip = Math.max(3, Math.round(Math.min(w, h) * 0.06));
  const samples: Array<[number, number, number]> = [];
  const push = (x: number, y: number): void => {
    const i = (y * w + x) * ch;
    samples.push([data[i], data[i + 1], data[i + 2]]);
  };
  for (let y = 0; y < strip; y++) for (let x = 0; x < w; x += 2) push(x, y);
  for (let y = h - strip; y < h; y++) for (let x = 0; x < w; x += 2) push(x, y);
  for (let x = 0; x < strip; x++) for (let y = 0; y < h; y += 2) push(x, y);
  for (let x = w - strip; x < w; x++) for (let y = 0; y < h; y += 2) push(x, y);
  const light = samples.filter(([r, g, b]) =>
    r >= 175 && g >= 175 && b >= 175 && Math.max(r, g, b) - Math.min(r, g, b) <= 45);
  if (light.length < samples.length * 0.28) return null; // 不是浅色底，别乱裁
  const median = (vals: number[]): number => {
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  };
  const bg: [number, number, number] = [
    median(light.map((c) => c[0])), median(light.map((c) => c[1])), median(light.map((c) => c[2])),
  ];
  const devs = light.map(([r, g, b]) => Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2])));
  const tol = Math.min(42, Math.max(18, 12 + median(devs) * 2));

  // ② 每行 / 每列的「非底色像素数」和亮度方差（用来认出整条纯色边框线）
  const rowCount = new Int32Array(h);
  const rowVar = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let cnt = 0; let s = 0; let s2 = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      const l = lum(data, i);
      s += l; s2 += l * l;
      if (Math.abs(data[i] - bg[0]) > tol || Math.abs(data[i + 1] - bg[1]) > tol || Math.abs(data[i + 2] - bg[2]) > tol) cnt++;
    }
    rowCount[y] = cnt;
    rowVar[y] = s2 / w - (s / w) ** 2;
  }
  const colCount = new Int32Array(w);
  const colVar = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    let cnt = 0; let s = 0; let s2 = 0;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * ch;
      const l = lum(data, i);
      s += l; s2 += l * l;
      if (Math.abs(data[i] - bg[0]) > tol || Math.abs(data[i + 1] - bg[1]) > tol || Math.abs(data[i + 2] - bg[2]) > tol) cnt++;
    }
    colCount[x] = cnt;
    colVar[x] = s2 / h - (s / h) ** 2;
  }

  /** 从一条边往里扫，返回第一个「有内容」的位置；rev 表示从尾部往回扫 */
  const scan = (
    count: Int32Array | Float64Array,
    variance: Int32Array | Float64Array,
    n: number,
    cross: number,
    rev: boolean,
  ): number => {
    const c = rev ? makeReversed(count) : count;
    const v = rev ? makeReversed(variance) : variance;
    let i = 0;
    let lineSkips = 0;
    while (i < n) {
      const frac = c[i] / cross;
      // 6% 的容差是给 JPEG 压缩留的：白边里常残留 2~3% 的噪点，
      // 阈值太紧会让扫描卡在边框线后第一列，白边一点都裁不掉。
      if (frac <= 0.06) { i++; continue; } // 几乎全是底色 → 留白
      // 整行 / 整列近乎纯色：多半是网格线或选中框。只有后面还跟着底色行才跳过，
      // 否则就是产品自己的纯色边，不能裁进去。
      if (lineSkips < 3 && i < n * 0.4 && v[i] < 900 && frac >= 0.6) {
        let bgAhead = false;
        for (let k = i + 1; k < Math.min(n, i + 5); k++) {
          if (c[k] / cross <= 0.08) { bgAhead = true; break; }
        }
        if (bgAhead) { lineSkips++; i++; continue; }
      }
      break;
    }
    return i;
  };

  const top = scan(rowCount, rowVar, h, w, false);
  const bottom = h - scan(rowCount, rowVar, h, w, true);
  const left = scan(colCount, colVar, w, h, false);
  const right = w - scan(colCount, colVar, w, h, true);
  const cw = right - left;
  const chh = bottom - top;
  if (cw < 32 || chh < 32 || cw < w * 0.25 || chh < h * 0.25) return null;
  if (cw > w * 0.94 && chh > h * 0.94) return null; // 没裁掉多少，没必要
  if (cw / chh < 0.12 || cw / chh > 8) return null;
  return { left, top, width: cw, height: chh };
}

function makeReversed(a: Int32Array | Float64Array): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[a.length - 1 - i];
  return out;
}

/** 按内容框裁出一份新的 RGB 小图（不重新解码大图） */
export function cropRaw(raw: RawImage, box: ContentBox): RawImage {
  const out = Buffer.allocUnsafe(box.width * box.height * raw.ch);
  for (let y = 0; y < box.height; y++) {
    const from = ((box.top + y) * raw.w + box.left) * raw.ch;
    out.set(raw.data.subarray(from, from + box.width * raw.ch), y * box.width * raw.ch);
  }
  return { data: out, w: box.width, h: box.height, ch: raw.ch };
}

function expandBox(box: ContentBox, raw: RawImage, pad: number): ContentBox {
  const left = Math.max(0, box.left - pad);
  const top = Math.max(0, box.top - pad);
  return {
    left, top,
    width: Math.min(raw.w - left, box.width + pad * 2),
    height: Math.min(raw.h - top, box.height + pad * 2),
  };
}

/** 截掉内容框某一条边：应对单元格截图把相邻一行的型号文字 / 表格线一起截进来 */
function trimBox(box: ContentBox, side: 'top' | 'bottom' | 'left' | 'right', frac: number): ContentBox {
  const dw = Math.round(box.width * frac);
  const dh = Math.round(box.height * frac);
  if (side === 'top') return { left: box.left, top: box.top + dh, width: box.width, height: box.height - dh };
  if (side === 'bottom') return { left: box.left, top: box.top, width: box.width, height: box.height - dh };
  if (side === 'left') return { left: box.left + dw, top: box.top, width: box.width - dw, height: box.height };
  return { left: box.left, top: box.top, width: box.width - dw, height: box.height };
}

/**
 * 一张图的「去白边」指纹：索引侧也存一份，客户图带白边、库里图不带（或反过来）
 * 都能对上。返回 null 表示这张图没有可裁的浅色边。
 */
export async function normalizedFeatures(buf: Buffer): Promise<ImageFeatures | null> {
  const raw = await decodeToRaw(buf);
  if (!raw) return null;
  const box = findContentBox(raw);
  if (!box) return null;
  const cropped = cropRaw(raw, box);
  return featuresFromRaw(cropped.data, cropped.w, cropped.h, cropped.ch);
}

export interface QueryVariants {
  variants: ImageFeatures[];
  /** 这张客户图确实带了一圈浅色底 / 表格边框，已额外生成去边指纹 */
  已裁白边: boolean;
}

/**
 * 查询图的候选指纹：原图 + 两档中心裁剪 + 自动去浅色边（含略微放宽的一档）。
 * 只要有一档和库里某张图对上就算命中，取最高分。
 */
export async function computeQueryFeatures(buf: Buffer): Promise<QueryVariants> {
  const out: ImageFeatures[] = [];
  let 已裁白边 = false;
  try {
    const meta = await sharp(buf, SHARP_OPTS).metadata();
    const first = await decodeImage(buf);
    if (!first) return { variants: out, 已裁白边 };
    out.push(first.features);
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w < 80 || h < 80) return { variants: out, 已裁白边 };
    for (const frac of [0.92, 0.82]) {
      const cw = Math.max(64, Math.round(w * frac));
      const ch = Math.max(64, Math.round(h * frac));
      const left = Math.floor((w - cw) / 2);
      const top = Math.floor((h - ch) / 2);
      try {
        const cropped = await sharp(buf, SHARP_OPTS)
          .extract({ left, top, width: cw, height: ch })
          .jpeg({ quality: 95 })
          .toBuffer();
        const d = await decodeImage(cropped);
        if (d) out.push(d.features);
      } catch {
        // 某个裁剪失败不影响原图结果
      }
    }
    // 客户从表格单元格复制 / 微信另存的图常带一大圈白底，还可能有网格线或选中框。
    // 中心裁剪去不掉这么宽的白边，sharp.trim 遇到边框线也会立刻停住，所以走内容框检测。
    const raw = await decodeToRaw(buf);
    if (raw) {
      const box = findContentBox(raw);
      if (box) {
        已裁白边 = true;
        const boxes: ContentBox[] = [box, expandBox(box, raw, Math.max(2, Math.round(Math.min(raw.w, raw.h) * 0.03)))];
        // 单元格截图可能把下面一行的型号文字 / 相邻格子一起截进来，再给几档单边裁切
        for (const [side, frac] of [
          ['bottom', 0.1], ['bottom', 0.18], ['top', 0.1],
          ['left', 0.1], ['right', 0.1],
        ] as Array<['top' | 'bottom' | 'left' | 'right', number]>) {
          const b = trimBox(box, side, frac);
          if (b.width >= 32 && b.height >= 32) boxes.push(b);
        }
        for (const b of boxes) {
          const cropped = cropRaw(raw, b);
          out.push(featuresFromRaw(cropped.data, cropped.w, cropped.h, cropped.ch));
        }
      }
    }
    // 非浅色底（例如深色纯色边）时，sharp.trim 仍能兜一手
    try {
      const trimmed = await sharp(buf, SHARP_OPTS).trim({ threshold: 12 }).png().toBuffer();
      const tm = await sharp(trimmed, SHARP_OPTS).metadata();
      if (tm.width && tm.height && (tm.width < w * 0.97 || tm.height < h * 0.97)) {
        const d = await decodeImage(trimmed);
        if (d) out.push(d.features);
      }
    } catch {
      // 没有可裁的纯色边就算了
    }
  } catch {
    // 交给上层报「图片打不开」
  }
  return { variants: out, 已裁白边 };
}

/** 0..1，越高越像 */
export function similarity(a: ImageFeatures, b: ImageFeatures): number {
  const dSim = 1 - hamming(a.d, b.d) / 64;
  const pSim = 1 - hamming(a.p, b.p) / 64;
  let diff = 0;
  const n = Math.min(a.c.length, b.c.length);
  for (let i = 0; i < n; i++) diff += Math.abs(a.c[i] - b.c[i]);
  const cSim = n ? 1 - diff / (n * 255) : 0;
  const rr = Math.abs(Math.log(Math.max(0.01, a.r) / Math.max(0.01, b.r)));
  const rSim = 1 - Math.min(1, rr / 0.8);
  return 0.42 * dSim + 0.38 * pSim + 0.15 * cSim + 0.05 * rSim;
}

/** 置信度分档：只有「高」才允许直接写进回复稿 */
export function confidenceLabel(score: number): '高' | '中' | '低' {
  if (score >= 0.88) return '高';
  if (score >= 0.8) return '中';
  return '低';
}
