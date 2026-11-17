import type { FastifyInstance } from 'fastify';
import { countCases, insertLearningRecord, listCases, upsertCase, type CaseRecord } from '../store/sqlite.js';
import { classifyIntent } from '../learning/intents.js';
import { rebuildScriptBook } from '../learning/scripts.js';

const ALIASES: Record<string, string[]> = {
  id: ['id', 'case_id', '编号', '案例编号'],
  country: ['country', '国家', '市场'],
  product: ['product', '产品', '品类'],
  stage: ['stage', '阶段'],
  reusable_script: ['reusable_script', '可复用话术', '话术', 'script'],
  attachments: ['attachments', '可发附件', '附件'],
  updated_at: ['updated_at', '更新时间', 'update_time', 'date'],
};

function pick(raw: Record<string, unknown>, key: string): unknown {
  for (const alias of ALIASES[key]) {
    for (const [k, v] of Object.entries(raw)) {
      if (k.trim().toLowerCase() === alias.toLowerCase() && v !== undefined && v !== '') return v;
    }
  }
  return undefined;
}

function parseCsv(text: string): Record<string, string>[] {
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (quoted && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = !quoted;
      } else if (c === ',' && !quoted) {
        out.push(cur.trim());
        cur = '';
      } else cur += c;
    }
    out.push(cur.trim());
    return out;
  };
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const head = split(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const o: Record<string, string> = {};
    head.forEach((h, i) => (o[h] = cells[i] ?? ''));
    return o;
  });
}

function parseMd(text: string): Record<string, string>[] {
  return text
    .split(/^---\s*$/m)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block, i) => {
      const o: Record<string, string> = { id: `md_${i + 1}` };
      for (const line of block.split(/\r?\n/)) {
        const m = line.match(/^\s*[-*]?\s*\*{0,2}([\w\u4e00-\u9fa5]+)\*{0,2}\s*[:：]\s*(.+)$/);
        if (m) o[m[1].trim()] = m[2].trim();
      }
      return o;
    });
}

function normalize(raw: Record<string, unknown>, index: number): { record?: CaseRecord; error?: string } {
  const id = pick(raw, 'id');
  const country = pick(raw, 'country');
  const product = pick(raw, 'product');
  const script = pick(raw, 'reusable_script');
  const attachments = pick(raw, 'attachments');
  const updated = pick(raw, 'updated_at');
  const missing: string[] = [];
  if (!id) missing.push('id');
  if (!country) missing.push('country');
  if (!product) missing.push('product');
  if (!script) missing.push('reusable_script/可复用话术');
  if (!attachments) missing.push('attachments/可发附件');
  if (!updated) missing.push('updated_at/更新时间');
  if (missing.length) return { error: `第 ${index + 1} 条缺少必填字段: ${missing.join(', ')}` };

  const list = Array.isArray(attachments)
    ? attachments.map(String)
    : String(attachments).split(/[,;，；|]/).map((s) => s.trim()).filter(Boolean);
  return {
    record: {
      id: String(id),
      country: String(country),
      product: String(product),
      stage: String(pick(raw, 'stage') ?? ''),
      reusable_script: String(script),
      attachments: list,
      updated_at: String(updated),
    },
  };
}

export default async function casesRoute(app: FastifyInstance): Promise<void> {
  /** 批量导入成功案例：JSON / CSV / MD，schema 校验不通过的案例绝不入库 */
  app.post('/v1/cases/import', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    let raws: unknown[] = [];
    const format = String(body.format ?? 'json').toLowerCase();
    try {
      if (Array.isArray(body)) raws = body;
      else if (Array.isArray(body.cases)) raws = body.cases;
      else if (typeof body.content === 'string') {
        const content = body.content;
        if (format === 'csv') raws = parseCsv(content);
        else if (format === 'md' || format === 'markdown') raws = parseMd(content);
        else raws = JSON.parse(content);
      } else raws = [];
    } catch (e) {
      return reply.code(400).send({ error: { message: `内容解析失败: ${(e as Error).message}`, type: 'invalid_request_error' } });
    }
    if (!Array.isArray(raws)) return reply.code(400).send({ error: { message: 'cases 必须是数组', type: 'invalid_request_error' } });

    const errors: string[] = [];
    let imported = 0;
    raws.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push(`第 ${i + 1} 条不是对象`);
        return;
      }
      const { record, error } = normalize(raw as Record<string, unknown>, i);
      if (error || !record) {
        errors.push(error ?? `第 ${i + 1} 条校验失败`);
        return;
      }
      upsertCase(record);
      // 导入的成功案例同时也是「成功样本」，立刻参与话术优化
      const rawObj = (raws[i] ?? {}) as Record<string, unknown>;
      const customerText = String(rawObj['客户消息'] ?? '');
      insertLearningRecord({
        id: `import_${record.id}`,
        source: 'import',
        label: 'success',
        note: '导入的成功案例',
        intent: classifyIntent(`${record.reusable_script} ${record.stage} ${customerText}`),
        country: record.country,
        product: record.product,
        stage: record.stage,
        customer_text: customerText,
        draft_text: record.reusable_script,
        attachments: record.attachments,
        agent: 'import',
      });
      imported++;
    });
    if (imported > 0) rebuildScriptBook();
    return reply.send({ imported, skipped: errors.length, errors, total: countCases() });
  });

  app.get('/v1/cases', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>;
    return { object: 'list', data: listCases({ country: q.country, product: q.product, q: q.q }, Number(q.limit ?? 20)), total: countCases() };
  });
}
