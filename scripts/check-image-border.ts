/**
 * 回归检查：客户「直接从表格单元格复制图片」带来的白边 / 边框，还能不能认出来。
 *
 *   npx tsx scripts/check-image-border.ts    （或 npm run check:image-border）
 *
 * 从当前图片索引里挑 10 张真实产品图，用 getOriginalImage 只读还原，
 * 再模拟 9 种单元格复制 / 微信转发的变形，逐张调 matchImage 看是否高置信命中自己。
 * 最后拿两张库外图确认不会因为多给几组裁剪变体而误命中。
 *
 * 只读原始资料；不写任何文件；库存表换了也能直接跑，样本从索引动态取。
 */
import sharp from 'sharp';
import { getImageIndex, getOriginalImage, matchImage } from '../apps/gateway/src/library/imageIndex.js';
import { hamming } from '../apps/gateway/src/library/imageFeatures.js';

interface Variant {
  name: string;
  make: (buf: Buffer, w: number, h: number) => Promise<Buffer>;
}

async function pad(buf: Buffer, w: number, h: number, f: number, bg: string): Promise<Buffer> {
  const dx = Math.round(w * f);
  const dy = Math.round(h * f);
  return sharp(buf).extend({ top: dy, bottom: dy, left: dx, right: dx, background: bg }).png().toBuffer();
}

/** 单元格比图片大：图原样居中，四周补白到 1:1，产品一点都不裁 */
async function padSquare(buf: Buffer, w: number, h: number, bg: string): Promise<Buffer> {
  const side = Math.round(Math.max(w, h) * 1.3);
  const dw = side - w; const dh = side - h;
  return sharp(buf).extend({
    top: Math.floor(dh / 2), bottom: dh - Math.floor(dh / 2),
    left: Math.floor(dw / 2), right: dw - Math.floor(dw / 2), background: bg,
  }).png().toBuffer();
}

/** Excel 把大图缩放进单元格：产品等比缩小后居中，四周补白 */
async function fitIntoWhite(buf: Buffer, w: number, h: number, frac: number): Promise<Buffer> {
  const iw = Math.max(32, Math.round(w * frac));
  const ih = Math.max(32, Math.round(h * frac));
  const inner = await sharp(buf).resize(iw, ih, { fit: 'fill' }).png().toBuffer();
  const side = Math.round(Math.max(w, h) * 1.1);
  const dw = side - iw; const dh = side - ih;
  return sharp(inner).extend({
    top: Math.floor(dh / 2), bottom: dh - Math.floor(dh / 2),
    left: Math.floor(dw / 2), right: dw - Math.floor(dw / 2), background: '#ffffff',
  }).png().toBuffer();
}

function frameSvg(w: number, h: number, color: string, px: number): Buffer {
  const lines = [
    `<rect x="0" y="0" width="${w}" height="${px}" fill="${color}"/>`,
    `<rect x="0" y="${h - px}" width="${w}" height="${px}" fill="${color}"/>`,
    `<rect x="0" y="0" width="${px}" height="${h}" fill="${color}"/>`,
    `<rect x="${w - px}" y="0" width="${px}" height="${h}" fill="${color}"/>`,
  ].join('');
  return Buffer.from(`<svg width="${w}" height="${h}">${lines}</svg>`);
}

async function withFrame(buf: Buffer, color: string, px: number): Promise<Buffer> {
  const m = await sharp(buf).metadata();
  return sharp(buf).composite([{ input: frameSvg(m.width!, m.height!, color, px), top: 0, left: 0 }]).png().toBuffer();
}

/** 单元格截图常把下面一行的型号文字一起带上 */
async function textStrip(buf: Buffer): Promise<Buffer> {
  const m = await sharp(buf).metadata();
  const w = m.width!; const h = m.height!;
  const stripH = Math.max(24, Math.round(h * 0.08));
  const svg = `<svg width="${w}" height="${stripH}"><rect width="100%" height="100%" fill="#ffffff"/>` +
    `<text x="${Math.round(w * 0.08)}" y="${Math.round(stripH * 0.7)}" font-size="${Math.round(stripH * 0.5)}" fill="#333333">TPU cover / A02s</text></svg>`;
  return sharp(buf)
    .extend({ top: 0, bottom: stripH, left: 0, right: 0, background: '#ffffff' })
    .composite([{ input: Buffer.from(svg), top: h, left: 0 }])
    .png().toBuffer();
}

async function asymPad(buf: Buffer, w: number, h: number): Promise<Buffer> {
  return sharp(buf).extend({
    top: Math.round(h * 0.08), bottom: Math.round(h * 0.22),
    left: Math.round(w * 0.28), right: Math.round(w * 0.04), background: '#ffffff',
  }).png().toBuffer();
}

const VARIANTS: Variant[] = [
  { name: '原图', make: async (b) => b },
  { name: '纯白边 12%', make: async (b, w, h) => pad(b, w, h, 0.12, '#ffffff') },
  { name: '补白到正方形 1:1', make: (b, w, h) => padSquare(b, w, h, '#ffffff') },
  { name: '图缩到 60% 居中补白', make: (b, w, h) => fitIntoWhite(b, w, h, 0.6).then((x) => sharp(x).jpeg({ quality: 82 }).toBuffer()) },
  { name: '米白边 #f7f6f2', make: (b, w, h) => pad(b, w, h, 0.18, '#f7f6f2').then((x) => sharp(x).jpeg({ quality: 88 }).toBuffer()) },
  { name: '不对称白边', make: (b, w, h) => asymPad(b, w, h).then((x) => sharp(x).jpeg({ quality: 85 }).toBuffer()) },
  { name: '白边+灰色网格线', make: (b, w, h) => pad(b, w, h, 0.15, '#ffffff').then((x) => withFrame(x, '#d9d9d9', 2)) },
  { name: '白边+深灰边框+压缩', make: (b, w, h) => pad(b, w, h, 0.2, '#ffffff').then((x) => withFrame(x, '#7f7f7f', 3)).then((x) => sharp(x).jpeg({ quality: 75 }).toBuffer()) },
  { name: '白边+底部文字条', make: (b, w, h) => pad(b, w, h, 0.12, '#ffffff').then(textStrip) },
];

async function main(): Promise<void> {
  const index = getImageIndex();
  if (!index || !index.图片.length) {
    console.log('没有图片索引：先运行 npm run build:images');
    process.exitCode = 1;
    return;
  }
  // 默认 10 张快速回归；BORDER_SAMPLES=40 可扩大样本，检查白底相似款之间会不会认错
  const sampleLimit = Math.max(1, Number(process.env.BORDER_SAMPLES) || 10);
  const priced = index.图片.filter((e) => e.型号);
  const others = index.图片.filter((e) => !e.型号);
  const picks = [...priced, ...others].slice(0, sampleLimit);
  console.log(`样本 ${picks.length} 张（索引共 ${index.图片.length} 张，特征版本 ${index.特征版本 ?? 1}）\n`);

  const tally = new Map<string, { hit: number; high: number; total: number }>();
  for (const v of VARIANTS) tally.set(v.name, { hit: 0, high: 0, total: 0 });

  // 库存表里可能同一张图挂在不同行（甚至价格不同）。这种情况下 top-1 落到另一条
  // 相同指纹的记录属于「并列」，不是认错；单独列出来提醒人工核对原表。
  const dupOf = new Map<string, Set<string>>();
  for (const a of index.图片) {
    for (const b of index.图片) {
      if (a.id === b.id) continue;
      if (hamming(a.f.d, b.f.d) === 0 && hamming(a.f.p, b.f.p) === 0) {
        const s = dupOf.get(a.id) ?? new Set<string>();
        s.add(b.id);
        dupOf.set(a.id, s);
      }
    }
  }

  for (const e of picks) {
    const original = await getOriginalImage(e.id);
    if (!original.ok) { console.log(`跳过 ${e.id}：${original.hint}`); continue; }
    const buf = Buffer.from(original.图片.split(',')[1] ?? '', 'base64');
    const m = await sharp(buf).metadata();
    const w = m.width!; const h = m.height!;
    const lines: string[] = [];
    for (const v of VARIANTS) {
      let q: Buffer;
      try { q = await v.make(buf, w, h); } catch { lines.push(`${v.name}: 生成失败`); continue; }
      const r = await matchImage(q, 5);
      const top = r.候选[0];
      const ok = top?.id === e.id;
      // 边框 / 压缩会让重复图的分数降到 0.91~0.97，只要仍是高置信且指纹完全相同就算并列
      const tie = !!top && top.置信度 === '高' && !!dupOf.get(e.id)?.has(top.id);
      const counted = ok || tie;
      const t = tally.get(v.name)!;
      t.total++;
      if (counted) t.hit++;
      if (counted && top.置信度 === '高') t.high++;
      lines.push(`${ok ? '✔' : tie ? '≈' : '✘'} ${v.name.padEnd(22)} ${top ? `${Math.round(top.相似度 * 100)}% / ${top.置信度}` : '无候选'}${top && !ok ? ` → ${top.id.slice(0, 6)}${tie ? '（同一张图挂在多行）' : ''}` : ''}`);
    }
    console.log(`[${e.id.slice(0, 6)} ${e.型号 || e.名称 || '无型号'} ${w}x${h}]`);
    for (const line of lines) console.log('   ', line);
  }

  console.log('\n===== 汇总：正确命中 / 高置信命中 / 样本数 =====');
  let hits = 0, highs = 0, total = 0;
  for (const [name, t] of tally) {
    console.log(`${name.padEnd(24)} ${t.hit}/${t.total}   高置信 ${t.high}/${t.total}`);
    hits += t.hit; highs += t.high; total += t.total;
  }
  console.log(`合计 ${hits}/${total} 命中，高置信 ${highs}/${total}`);

  // 误命中检查：完全不在库里的图不该被认成高置信
  const negatives: Array<{ name: string; buf: Buffer }> = [
    {
      name: '库外·白底文字截图',
      buf: await sharp({ create: { width: 640, height: 640, channels: 3, background: '#ffffff' } })
        .composite([{ input: Buffer.from('<svg width="640" height="640"><text x="50" y="200" font-size="60" fill="#222222">Quotation List 2026</text><text x="50" y="320" font-size="46" fill="#444444">Model A02s  USD 0.45</text><text x="50" y="440" font-size="46" fill="#444444">Total  1200 pcs</text></svg>'), top: 0, left: 0 }])
        .jpeg({ quality: 85 }).toBuffer(),
    },
    {
      name: '库外·彩色几何图',
      buf: await sharp({ create: { width: 500, height: 500, channels: 3, background: '#f5f5f5' } })
        .composite([{ input: Buffer.from('<svg width="500" height="500"><circle cx="250" cy="250" r="180" fill="#d4553f"/><rect x="180" y="80" width="140" height="340" fill="#2f5d50"/></svg>'), top: 0, left: 0 }])
        .png().toBuffer(),
    },
  ];
  const groups: string[][] = [];
  const seenGroup = new Set<string>();
  for (const [id, ids] of dupOf) {
    const key = [id, ...ids].sort().join('|');
    if (seenGroup.has(key)) continue;
    seenGroup.add(key);
    groups.push([id, ...ids]);
  }
  if (groups.length) {
    console.log('\n===== 注意：同一张产品图在库存表里出现多行 =====');
    for (const g of groups) {
      const rows = g.map((id) => {
        const e = index.图片.find((x) => x.id === id)!;
        return `${e.工作表}·第 ${e.行号} 行 ${e.型号 || '(无型号)'} ${e.价格 != null ? `${e.价格原文 || e.价格} ${e.币种 || ''}` : '未填价'}`;
      });
      console.log(`  ${g.map((x) => x.slice(0, 6)).join(' / ')} → ${rows.join(' ｜ ')}`);
    }
    console.log('  这不是识别错误：图完全相同。价格 / 型号不一致时必须人工打开原表确认哪一行是当前这批货。');
  }

  console.log('\n===== 误命中检查（不应出现高置信）=====');
  let falsePositive = false;
  for (const n of negatives) {
    const r = await matchImage(n.buf, 5);
    const top = r.候选[0];
    const bad = top?.置信度 === '高';
    if (bad) falsePositive = true;
    console.log(`${n.name.padEnd(20)} 候选 ${r.候选.length} 个，最高 ${top ? `${Math.round(top.相似度 * 100)}% / ${top.置信度}` : '无'} ${bad ? '⚠ 误命中' : '✔ 正常'}`);
  }

  const rate = total ? highs / total : 0;
  console.log(`\n结论：${rate >= 0.9 && !falsePositive ? '通过' : '未通过'}（要求高置信命中率 ≥ 90% 且无误命中）`);
  if (rate < 0.9 || falsePositive) process.exitCode = 1;
}
void main();
