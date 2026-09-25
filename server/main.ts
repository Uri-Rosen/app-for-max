import { spawn } from 'node:child_process';
import http from 'node:http';
import { DB_PATH, HOST, PORT } from './config.ts';
import { openDb } from './db/index.ts';
import { buildApp } from './http.ts';
import { autoBackupIfNeeded, autoExportIfNeeded } from './services/backup.ts';
import { processQueue } from './services/sources.ts';

const url = `http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`;
const wantsOpen = process.argv.includes('--open');

function openBrowser(): void {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

function housekeeping(): void {
  try {
    const b = autoBackupIfNeeded();
    if (b) console.log(`גיבוי אוטומטי: ${b.file}`);
    const x = autoExportIfNeeded();
    if (x) console.log(`ייצוא JSON שבועי: ${x}`);
  } catch (e) {
    console.error('הגיבוי האוטומטי נכשל:', (e as Error).message);
  }
}

/** True when an instance of this app already answers on the port. */
async function alreadyRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/api/bootstrap`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

// A second launch (e.g. double-clicking Start.cmd again) must not open the
// database a second time — just point the browser at the running one.
if (await alreadyRunning()) {
  console.log(`המערכת כבר פועלת: ${url}`);
  if (wantsOpen) openBrowser();
  process.exit(0);
}

openDb(DB_PATH);
housekeeping();
// The study day can roll over while the server stays up; check hourly.
setInterval(housekeeping, 60 * 60 * 1000).unref();
void processQueue();

// Plain http.Server: Express 5's app.listen() also calls its callback on errors,
// which would announce "running" (and open the browser) when the port is taken.
const server = http.createServer(buildApp());
server.listen(PORT, HOST, () => {
  console.log(`מערכת הזיכרון פועלת: ${url}`);
  console.log(`מסד הנתונים: ${DB_PATH}`);
  if (wantsOpen) openBrowser();
});
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`הפורט ${PORT} תפוס על ידי תוכנה אחרת. אפשר להריץ על פורט אחר עם המשתנה MEMORY_PORT.`);
    process.exit(1);
  }
  throw e;
});
