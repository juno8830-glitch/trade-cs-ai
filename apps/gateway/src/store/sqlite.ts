import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { cfg } from '../config.js';

// Node 22 内置 SQLite，无需 better-sqlite3 原生编译
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (file: string) => DB;
};

interface Stmt {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, any> | undefined;
  all(...params: unknown[]): Record<string, any>[];
}
interface DB {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}

fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
export const db: DB = new DatabaseSync(cfg.dbPath);

export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      channel TEXT,
      customer TEXT,
      last_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT,
      agent TEXT,
      prompt_hash TEXT,
      tools_called TEXT,
      need_confirm INTEGER DEFAULT 0,
      price_sensitive INTEGER DEFAULT 0,
      sent INTEGER DEFAULT 0,
      operator TEXT,
      latency_ms INTEGER,
      channel TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_logs(session_id);
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      country TEXT,
      product TEXT,
      stage TEXT,
      reusable_script TEXT,
      attachments TEXT,
      updated_at TEXT,
      payload TEXT
    );
    CREATE TABLE IF NOT EXISTS ingress_dedupe (
      msg_id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL
    );
    -- 学习记录：每次生成的回复都留一条，客服可标记「成功 / 失败」。
    -- 客户原文与回复稿只存在本机 data/gateway.db，不上传、不发给客户。
    CREATE TABLE IF NOT EXISTS learning_records (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,           -- chat=程序对话 / import=导入案例 / workbuddy=WorkBuddy 整理
      label TEXT,                     -- success / failure / NULL(还没标记)
      note TEXT,                      -- 成功或失败的原因（中文，客服自己写）
      intent TEXT,                    -- 自动识别的客户场景
      country TEXT,
      product TEXT,
      stage TEXT,
      locale TEXT,
      customer_text TEXT,
      draft_text TEXT,
      attachments TEXT,
      agent TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      rated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_learning_label ON learning_records(label);
    CREATE INDEX IF NOT EXISTS idx_learning_session ON learning_records(session_id);
  `);
}

/* ==================== 学习记录（聊天记录 + 成功/失败标记） ==================== */

export interface LearningRecord {
  id: string;
  source: string;
  label: string | null;
  note: string | null;
  intent: string;
  country: string;
  product: string;
  stage: string;
  locale: string;
  customer_text: string;
  draft_text: string;
  attachments: string[];
  agent: string;
  session_id: string;
  created_at: number;
  rated_at: number | null;
}

export interface NewLearningRecord {
  id?: string;
  source?: string;
  label?: string | null;
  note?: string;
  intent?: string;
  country?: string;
  product?: string;
  stage?: string;
  locale?: string;
  customer_text?: string;
  draft_text?: string;
  attachments?: string[];
  agent?: string;
  session_id?: string;
}

function rowToRecord(r: Record<string, any>): LearningRecord {
  let attachments: string[] = [];
  try { attachments = JSON.parse(String(r.attachments ?? '[]')); } catch { /* 忽略坏数据 */ }
  return {
    id: String(r.id), source: String(r.source), label: r.label == null ? null : String(r.label),
    note: r.note == null ? null : String(r.note), intent: String(r.intent ?? 'greeting'),
    country: String(r.country ?? ''), product: String(r.product ?? ''), stage: String(r.stage ?? ''),
    locale: String(r.locale ?? ''), customer_text: String(r.customer_text ?? ''),
    draft_text: String(r.draft_text ?? ''), attachments, agent: String(r.agent ?? ''),
    session_id: String(r.session_id ?? ''), created_at: Number(r.created_at ?? 0),
    rated_at: r.rated_at == null ? null : Number(r.rated_at),
  };
}

export function insertLearningRecord(r: NewLearningRecord): string {
  const id = r.id ?? `lr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(
    `INSERT OR REPLACE INTO learning_records
      (id,source,label,note,intent,country,product,stage,locale,customer_text,draft_text,attachments,agent,session_id,created_at,rated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, r.source ?? 'chat', r.label ?? null, r.note ?? null, r.intent ?? 'greeting',
    r.country ?? '', r.product ?? '', r.stage ?? '', r.locale ?? '',
    r.customer_text ?? '', r.draft_text ?? '', JSON.stringify(r.attachments ?? []),
    r.agent ?? '', r.session_id ?? '', Date.now(), r.label ? Date.now() : null,
  );
  return id;
}

export function getLearningRecord(id: string): LearningRecord | undefined {
  const r = db.prepare(`SELECT * FROM learning_records WHERE id=?`).get(id);
  return r ? rowToRecord(r) : undefined;
}

export function latestRecordBySession(sessionId: string): LearningRecord | undefined {
  const r = db.prepare(`SELECT * FROM learning_records WHERE session_id=? AND source='chat' ORDER BY created_at DESC LIMIT 1`).get(sessionId);
  return r ? rowToRecord(r) : undefined;
}

export function rateLearningRecord(id: string, label: string, note: string): boolean {
  const info = db.prepare(`UPDATE learning_records SET label=?, note=?, rated_at=? WHERE id=?`)
    .run(label, note, Date.now(), id);
  return info.changes > 0;
}

export function deleteLearningRecord(id: string): boolean {
  return db.prepare(`DELETE FROM learning_records WHERE id=?`).run(id).changes > 0;
}

export function listLearningRecords(
  filter: { label?: string; intent?: string; q?: string } = {},
  limit = 50,
): LearningRecord[] {
  let rows = db.prepare(`SELECT * FROM learning_records ORDER BY created_at DESC LIMIT 200`).all().map(rowToRecord);
  if (filter.label === 'unlabeled') rows = rows.filter((r) => !r.label);
  else if (filter.label) rows = rows.filter((r) => r.label === filter.label);
  if (filter.intent) rows = rows.filter((r) => r.intent === filter.intent);
  if (filter.q) {
    const q = filter.q.toLowerCase();
    rows = rows.filter((r) => `${r.customer_text} ${r.draft_text} ${r.note ?? ''}`.toLowerCase().includes(q));
  }
  return rows.slice(0, Math.min(limit, 200));
}

/** 已被标记的记录 = 真正能拿来优化话术的样本 */
export function labeledSamples(): LearningRecord[] {
  return db.prepare(`SELECT * FROM learning_records WHERE label IN ('success','failure') ORDER BY rated_at DESC LIMIT 300`)
    .all().map(rowToRecord);
}

export function learningStats(): Record<string, unknown> {
  const rows = db.prepare(`SELECT label, intent, COUNT(*) AS n FROM learning_records GROUP BY label, intent`).all();
  let total = 0, success = 0, failure = 0, unlabeled = 0;
  const byIntent: Record<string, { success: number; failure: number; unlabeled: number }> = {};
  for (const r of rows) {
    const n = Number(r.n);
    total += n;
    const key = String(r.intent ?? 'greeting');
    const bucket = (byIntent[key] ??= { success: 0, failure: 0, unlabeled: 0 });
    if (r.label === 'success') { success += n; bucket.success += n; }
    else if (r.label === 'failure') { failure += n; bucket.failure += n; }
    else { unlabeled += n; bucket.unlabeled += n; }
  }
  const labeled = success + failure;
  return {
    total, success, failure, unlabeled, labeled,
    success_rate: labeled ? Number((success / labeled).toFixed(4)) : 0,
    by_intent: byIntent,
    cases_count: countCases(),
  };
}

export interface CaseRecord {
  id: string;
  country: string;
  product: string;
  stage: string;
  reusable_script: string;
  attachments: string[];
  updated_at: string;
}

export function upsertSession(sessionId: string, channel: string, customer: unknown, agent: string): void {
  db.prepare(
    `INSERT INTO sessions(session_id, created_at, channel, customer, last_agent) VALUES(?,?,?,?,?)
     ON CONFLICT(session_id) DO UPDATE SET last_agent=excluded.last_agent`,
  ).run(sessionId, Date.now(), channel, JSON.stringify(customer ?? {}), agent);
}

export function getSession(sessionId: string): Record<string, any> | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE session_id=?`).get(sessionId);
}

export function upsertCase(c: CaseRecord): void {
  db.prepare(
    `INSERT INTO cases(id,country,product,stage,reusable_script,attachments,updated_at,payload) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET country=excluded.country, product=excluded.product, stage=excluded.stage,
       reusable_script=excluded.reusable_script, attachments=excluded.attachments,
       updated_at=excluded.updated_at, payload=excluded.payload`,
  ).run(c.id, c.country, c.product, c.stage, c.reusable_script, JSON.stringify(c.attachments), c.updated_at, JSON.stringify(c));
}

export function listCases(filter: { country?: string; product?: string; q?: string } = {}, limit = 20): CaseRecord[] {
  const rows = db.prepare(`SELECT payload FROM cases ORDER BY updated_at DESC`).all();
  return rows
    .map((r) => JSON.parse(String(r.payload)) as CaseRecord)
    .filter((c) => !filter.country || c.country?.toUpperCase() === filter.country.toUpperCase())
    .filter((c) => !filter.product || (c.product ?? '').toLowerCase().includes(filter.product.toLowerCase()))
    .filter((c) => !filter.q || JSON.stringify(c).toLowerCase().includes(filter.q.toLowerCase()))
    .slice(0, limit);
}

export function countCases(): number {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM cases`).get()?.n ?? 0);
}

export function deleteCase(id: string): boolean {
  return db.prepare(`DELETE FROM cases WHERE id=?`).run(id).changes > 0;
}

export interface AuditRecord {
  session_id?: string;
  agent: string;
  prompt_hash: string;
  tools_called: unknown[];
  need_confirm: boolean;
  price_sensitive: boolean;
  latency_ms: number;
  channel?: string;
}

export function insertAudit(r: AuditRecord): number {
  const info = db.prepare(
    `INSERT INTO audit_logs(ts,session_id,agent,prompt_hash,tools_called,need_confirm,price_sensitive,sent,operator,latency_ms,channel)
     VALUES(?,?,?,?,?,?,?,0,NULL,?,?)`,
  ).run(Date.now(), r.session_id ?? null, r.agent, r.prompt_hash, JSON.stringify(r.tools_called), r.need_confirm ? 1 : 0, r.price_sensitive ? 1 : 0, r.latency_ms, r.channel ?? null);
  return Number(info.lastInsertRowid);
}

export function markSent(sessionId: string, operator: string): number {
  const info = db.prepare(
    `UPDATE audit_logs SET sent=1, operator=? WHERE id=(SELECT id FROM audit_logs WHERE session_id=? ORDER BY id DESC LIMIT 1)`,
  ).run(operator, sessionId);
  return info.changes;
}

export function listAudit(limit = 50): Record<string, any>[] {
  return db.prepare(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?`).all(limit);
}

export function metrics(): Record<string, unknown> {
  const row = db.prepare(
    `SELECT COUNT(*) AS total, SUM(sent) AS sent, SUM(need_confirm) AS need_confirm,
            SUM(price_sensitive) AS price_sensitive, AVG(latency_ms) AS avg_latency_ms
     FROM audit_logs`,
  ).get() ?? {};
  const byAgent = db.prepare(`SELECT agent, COUNT(*) AS n FROM audit_logs GROUP BY agent ORDER BY n DESC`).all();
  const total = Number(row.total ?? 0);
  const sent = Number(row.sent ?? 0);
  return {
    total_suggestions: total,
    sent_count: sent,
    adoption_rate: total ? Number((sent / total).toFixed(4)) : 0,
    need_confirm_count: Number(row.need_confirm ?? 0),
    price_sensitive_count: Number(row.price_sensitive ?? 0),
    avg_latency_ms: Math.round(Number(row.avg_latency_ms ?? 0)),
    by_agent: byAgent,
    cases_count: countCases(),
  };
}

export function isDuplicate(msgId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM ingress_dedupe WHERE msg_id=?`).get(msgId));
}

export function rememberMsg(msgId: string): void {
  db.prepare(`INSERT OR IGNORE INTO ingress_dedupe(msg_id,ts) VALUES(?,?)`).run(msgId, Date.now());
}
