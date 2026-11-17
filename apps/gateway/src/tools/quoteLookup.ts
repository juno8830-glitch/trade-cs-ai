import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config.js';
import { getIndex, organizeLibrary, type QuoteRow } from '../library/organizer.js';
import type { ToolResult } from './index.js';

/**
 * 报价查询：优先读「资料索引」，索引不存在就现场整理一次。
 *
 * 为什么不再用 XLSX.readFile？
 *   用户真实的库存表里嵌了大量产品图，单文件 400MB+，整个解压会卡死或爆内存；
 *   而且表头是「型号 / 出厂价 / 货期」，跟早期示例表的「SKU / 价格(USD)」对不上，
 *   老逻辑直接 continue，所以表现为「问报价什么都不查」。
 *   整理器会把这些表统一转成结构化的索引（型号→价格/币种/货期/来源行号），这里只查索引。
 */

function nk(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[\s_\-#]/g, '').replace(/[（(].*?[)）]/g, '');
}

function toDetail(q: QuoteRow): Record<string, unknown> {
  return {
    型号: q.型号,
    名称: q.名称,
    规格: q.规格,
    价格: q.价格,
    价格原文: q.价格原文,
    附加价格: q.附加价格,
    币种: q.币种,
    货期: q.货期,
    MOQ: q.MOQ,
    系列: q.系列,
    识别方式: q.识别方式,
    备注: q.备注,
    文件: q.文件,
    工作表: q.工作表,
    行号: q.行号,
  };
}

export function quoteLookup(args: { sku?: string }): ToolResult {
  const sku = String(args.sku ?? '').trim();
  if (!sku) return { ok: false, data: { hint: '缺少 sku 参数' } };
  if (!fs.existsSync(cfg.kbRoot)) {
    return { ok: false, data: { hint: `资料文件夹不存在：${cfg.kbRoot}` } };
  }

  let index = getIndex();
  if (!index) {
    // 用户没点过「整理资料」也能查：首次查询现场整理一次（只读，约 0.2 秒）
    organizeLibrary();
    index = getIndex();
  }
  if (!index) {
    return { ok: false, data: { sku, hint: '资料库整理失败，请在界面点「一键整理资料」；在查到真实数据前禁止虚构价格' } };
  }

  const key = nk(sku);
  const all = index.报价;
  let hits = all.filter((q) => nk(q.型号) === key);
  if (!hits.length) hits = all.filter((q) => nk(q.型号).includes(key) || (key.length >= 3 && q.关键词.includes(key)));
  if (!hits.length) {
    const kw = sku.toLowerCase();
    hits = all.filter((q) => q.关键词.includes(kw)).slice(0, 8);
  }
  if (!hits.length) {
    return {
      ok: false,
      data: {
        sku,
        hint: `资料库的 ${index.统计.型号数} 个型号里没有找到「${sku}」，禁止虚构价格，请写「待人工补充」。可参考的型号：${index.型号目录.slice(0, 5).map((m) => m.型号).join('、')}`,
      },
    };
  }

  const first = hits[0];
  const prices = hits.map((q) => q.价格).filter((p): p is number => typeof p === 'number' && p > 0);
  const currency = first.币种 || 'CNY';
  const priceLabel = currency === 'USD' ? '美元' : currency === 'EUR' ? '欧元' : '人民币';
  const loose = hits.some((q) => q.识别方式 === '宽松识别');

  return {
    ok: true,
    data: {
      sku: first.型号,
      // 兼容老客户端字段名；真实币种以 currency 为准，别把它当美元
      price_usd: first.价格,
      price: first.价格,
      price_raw: first.价格原文,
      price_note: `这是资料表里的${priceLabel}出厂价 / 表内价格，不是对外正式报价`,
      price_range: prices.length ? `${Math.min(...prices)} ~ ${Math.max(...prices)}` : '',
      currency,
      unit: '件',
      moq: first.MOQ,
      lead_time: first.货期,
      effective_date: '',
      extra_prices: first.附加价格,
      series: first.系列,
      recognition: first.识别方式,
      row: first.行号,
      sheet: first.工作表,
      file: path.basename(first.文件),
      source_path: first.文件,
      match_count: hits.length,
      matches: hits.slice(0, 8).map(toDetail),
      hint: [
        `命中 ${hits.length} 行，来自「${first.文件}」工作表「${first.工作表}」第 ${first.行号} 行起。`,
        `币种 ${currency}（${priceLabel}），价格 ${first.价格原文 || String(first.价格 ?? '未填')}。`,
        first.附加价格 ? `同一款还有：${first.附加价格}。` : '',
        loose ? '其中部分行是「宽松识别」（原表无标准表头），务必打开原文件核对。' : '',
        '这是表内价格，不是对外正式报价；必须人工核对后才能写进给客户的稿子。',
      ].filter(Boolean).join(''),
    },
  };
}
