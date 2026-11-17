/**
 * 命令行版「重建图片索引」——客户带图询价前跑一次即可。
 *
 * 运行：npm run build:images
 *      或 node node_modules/tsx/dist/cli.mjs scripts/build-image-index.ts
 * 加 --force 会忽略已有指纹，全部重新解码（换过报价表图片时用）。
 *
 * 只读用户原始资料；只写 data/图片索引.json 和 data/图片缓存/*.webp。
 * 支持 .xlsx 内嵌图、老式 .xls 的 ETCellImageData 单元格图片、以及独立图片文件。
 * 首次跑要逐张解码表里的产品图，可能要几分钟；之后命中缓存只补增量。
 */
import { buildImageIndex } from '../apps/gateway/src/library/imageIndex.js';

const force = process.argv.includes('--force');
let lastBucket = -1;
const r = await buildImageIndex({
  force,
  onProgress: (s) => {
    if (!s.total) return;
    const bucket = Math.floor(s.done / 200);
    if (bucket !== lastBucket && bucket > 0) {
      lastBucket = bucket;
      console.log(`  … ${s.message}`);
    }
  },
});

console.log('');
console.log('  【图片索引】' + (r.ok ? '完成' : '没成功'));
console.log('  ' + r.摘要);
if (r.ok) {
  console.log(`  图片 ${r.统计.图片数} 张 · 关联型号 ${r.统计.有关联型号} 张 · 未关联 ${r.统计.未关联型号} 张 · 报价表 ${r.统计.报价表数} 个`);
  console.log(`  新建缩略图 ${r.统计.新建缩略图} 张 · 复用 ${r.统计.复用缩略图} 张 · 解码失败 ${r.统计.解码失败} 张`);
  console.log('  用时 ' + r.耗时毫秒 + ' 毫秒');
  console.log('  索引：' + r.索引路径);
  if (r.建议.length) {
    console.log('  整理建议：');
    for (const t of r.建议) console.log('    - ' + t);
  }
  console.log('  提醒：表内价格是出厂价 / 内部价，发给客户前仍需人工核对来源文件对应行；程序不会自动发送消息给客户。');
} else {
  console.log('  检查：data/客服资料库 是否存在、库存表是否可读（.xls / .xlsx 都支持）、是否先跑过 npm run organize:library。');
}
console.log('');
if (!r.ok) process.exitCode = 1;
