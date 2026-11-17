import { listCases } from '../store/sqlite.js';
import type { ToolResult } from './index.js';

/** 只检索已入库且通过 schema 校验的案例；未入库案例 AI 不可引用 */
export function caseSearch(args: { country?: string; product?: string; keyword?: string; limit?: number }): ToolResult {
  const cases = listCases(
    { country: args.country, product: args.product, q: args.keyword },
    Math.min(Number(args.limit ?? 5), 20),
  );
  return {
    ok: cases.length > 0,
    data: {
      cases: cases.map((c) => ({
        id: c.id,
        country: c.country,
        product: c.product,
        stage: c.stage,
        reusable_script: c.reusable_script,
        attachments: c.attachments,
        updated_at: c.updated_at,
      })),
      ...(cases.length ? {} : { hint: '案例库无匹配记录，禁止虚构成功案例' }),
    },
  };
}
