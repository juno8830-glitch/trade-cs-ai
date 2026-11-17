/**
 * 演示数据脚本已停用。
 *
 * 以前这里会往 data/客服资料库 写入铝合金型材的假报价表、1x1 占位图片、
 * 假证书，以及 data/cases/cases.json 里的假成功案例。这些测试数据和旧索引
 * 已在 2026-11-13 全部清除，资料库现在只放用户自己的真实库存表 / 报价文档。
 *
 * 为了不让「npm run seed」误跑一次就把假数据重新写回真实资料库，这里不再
 * 生成任何文件，只打印提示。需要真实资料时，请把文件直接放进
 * data/客服资料库，然后运行 npm run organize:library。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB = path.join(ROOT, 'data', '客服资料库');

console.log('[seed] 演示数据已停用：不会写入任何文件。');
console.log(`[seed] 真实资料目录：${KB}`);
console.log('[seed] 放入自己的库存表 / 报价文档后，运行 npm run organize:library 整理即可。');
