import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { now } from '../clock.ts';
import { migrate } from './schema.ts';

export type Row = Record<string, unknown>;
type Param = unknown;

let db: DatabaseSync | null = null;
let dbPath: string | null = null;
let cache = new Map<string, StatementSync>();
let txDepth = 0;

export function openDb(file: string): DatabaseSync {
  closeDb();
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  dbPath = file;
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

export function closeDb(): void {
  if (db) {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // closing anyway
    }
    db.close();
  }
  db = null;
  cache = new Map();
  txDepth = 0;
}

export function currentDbPath(): string {
  if (!dbPath) throw new Error('database not open');
  return dbPath;
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('database not open');
  return db;
}

function stmt(sql: string): StatementSync {
  let s = cache.get(sql);
  if (!s) {
    s = getDb().prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

function clean(params: Param[]): SQLInputValue[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p !== null && typeof p === 'object' && !(p instanceof Uint8Array)) return JSON.stringify(p);
    return p as SQLInputValue;
  });
}

export function all<T = Row>(sql: string, ...params: Param[]): T[] {
  return stmt(sql).all(...clean(params)) as T[];
}

export function get<T = Row>(sql: string, ...params: Param[]): T | undefined {
  return stmt(sql).get(...clean(params)) as T | undefined;
}

export function run(sql: string, ...params: Param[]): { changes: number; lastId: number } {
  const r = stmt(sql).run(...clean(params));
  return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
}

export function exec(sql: string): void {
  getDb().exec(sql);
}

/** Runs fn in one transaction. Nested calls join the outer transaction. */
export function tx<T>(fn: () => T): T {
  if (txDepth > 0) {
    txDepth++;
    try {
      return fn();
    } finally {
      txDepth--;
    }
  }
  getDb().exec('BEGIN IMMEDIATE');
  txDepth = 1;
  try {
    const out = fn();
    getDb().exec('COMMIT');
    return out;
  } catch (e) {
    getDb().exec('ROLLBACK');
    throw e;
  } finally {
    txDepth = 0;
  }
}

export function nowIso(): string {
  return now().toISOString();
}

export function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || v === '') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/** Table name → primary key column. Everything else uses `id`. */
export const TABLE_PK: Record<string, string> = { settings: 'key', day_log: 'local_date' };

export const TABLES = [
  'settings',
  'courses',
  'topics',
  'topic_aliases',
  'lessons',
  'sources',
  'lesson_topics',
  'lesson_sources',
  'units',
  'questions',
  'source_chunks',
  'source_links',
  'reviews',
  'day_log',
  'ai_runs',
  'audit_log',
] as const;
