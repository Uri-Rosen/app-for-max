import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DATA_DIR = path.resolve(process.env.MEMORY_DATA_DIR ?? path.join(APP_ROOT, 'data'));
export const DB_PATH = path.join(DATA_DIR, 'memory.db');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const EXPORT_DIR = path.join(DATA_DIR, 'exports');
/** Copies of uploaded files. Files found by folder scan are referenced in place and never copied or modified. */
export const UPLOAD_DIR = path.join(DATA_DIR, 'sources');
export const WEB_DIST = path.join(APP_ROOT, 'web', 'dist');

export const PORT = Number(process.env.MEMORY_PORT ?? 4317);
/** Local only: the server never listens on a public interface. */
export const HOST = '127.0.0.1';
