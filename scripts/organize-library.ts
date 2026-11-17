/**
 * 命令行版「整理资料库」——给 WorkBuddy 的定时任务 / 懂一点的用户用。
 *
 * 运行：npm run organize:library
 *      或 node node_modules/tsx/dist/cli.mjs scripts/organize-library.ts
 * 加 --force 会忽略缓存全部重读（换过表头时用）。
 *
 * 只读用户原始资料；只写 data/资料索引.json、data/资料索引.缓存.json、data/资料清单.md。
 */
import { organizeLibrary } from '../apps/gateway/src/library/organizer.js';

const force = process.argv.includes('--force');
const r = organizeLibrary({ force });

console.log('');
console.log('  【资料库整理】' + (r.ok ? '完成' : '没成功'));
console.log('  ' + r.摘要);
if (r.ok) {
  console.log(`  报价表 ${r.统计.报价表数} 个 · 型号 ${r.统计.型号数} 个 · 报价行 ${r.统计.报价行数} 行 · 图片 ${r.统计.图片数} 张 · 表内嵌图 ${r.统计.内嵌图片} 张`);
  console.log('  用时 ' + r.耗时毫秒 + ' 毫秒');
  console.log('  清单：' + r.清单路径);
  console.log('  索引：' + r.索引路径);
  if (r.新增文件.length) console.log('  新增文件：' + r.新增文件.join('、'));
  if (r.变更文件.length) console.log('  更新文件：' + r.变更文件.join('、'));
  if (r.建议.length) {
    console.log('  整理建议：');
    for (const t of r.建议) console.log('    - ' + t);
  }
}
console.log('');
if (!r.ok) process.exitCode = 1;
