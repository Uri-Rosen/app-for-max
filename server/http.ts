import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { listAudit, undoAction } from './audit.ts';
import { PORT, WEB_DIST } from './config.ts';
import { getProvider } from './ai/index.ts';
import { isIsoDate } from '../shared/dates.ts';
import {
  autoBackupIfNeeded,
  backupNow,
  exportJson,
  listBackups,
  restoreFromBackup,
  restoreFromJson,
  saveUploadedBackup,
} from './services/backup.ts';
import { buildWorkbook } from './services/excel.ts';
import {
  bulkQuestions,
  importCards,
  previewCards,
  queueCounts,
  reviewQueue,
  suggestFromSource,
} from './services/proposals.ts';
import { getToday, submitReview } from './services/session.ts';
import { clockOffset, getSettings, setClockOffsetDays, today, updateSettings } from './services/settings.ts';
import {
  createManualSource,
  extractSource,
  getChunk,
  getChunks,
  getSource,
  isQueueRunning,
  listSources,
  processQueue,
  scanFolders,
  searchChunks,
  setSourceStatus,
  sourceFile,
  updateSource,
  uploadSource,
} from './services/sources.ts';
import { calendar, calendarDay, progress } from './services/stats.ts';
import {
  UserError,
  createCourse,
  createLesson,
  createTopic,
  getCourse,
  lessonsForCourse,
  listCourses,
  mergeTopics,
  setTopicStatus,
  topicsForCourse,
  updateCourse,
  updateLesson,
  updateTopic,
} from './services/structure.ts';
import {
  addLink,
  approveQuestion,
  approveUnit,
  createQuestion,
  createUnit,
  getQuestion,
  getUnitDetail,
  rejectQuestion,
  rejectUnit,
  removeLink,
  resolveConflict,
  restartUnit,
  unitsForCourse,
  updateQuestion,
  updateUnit,
} from './services/units.ts';

type Handler = (req: Request, res: Response) => unknown;

/** Sends whatever the handler returns as JSON; errors go to the error middleware. */
const h =
  (fn: Handler) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      next(e);
    }
  };

const id = (req: Request, name = 'id'): number => {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw new UserError('מזהה לא תקין');
  return n;
};

export function buildApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // Only this machine: reject requests whose Host header isn't local (DNS-rebinding guard).
  app.use((req, res, next) => {
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
      res.status(403).json({ error: 'גישה מותרת רק מהמחשב הזה' });
      return;
    }
    next();
  });

  const api = express.Router();

  // CSRF guard. A web page elsewhere can still fire simple cross-site POSTs at a
  // local port; it cannot add a custom header without a CORS preflight, which
  // this server never grants. So every write must carry X-Memory-App, and any
  // Origin present must be this app's own.
  api.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.headers.origin;
    const own = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, 'http://localhost:5173', 'http://127.0.0.1:5173']);
    if ((origin && !own.has(origin)) || req.headers['x-memory-app'] !== '1') {
      res.status(403).json({ error: 'בקשה נחסמה: מותר לשנות נתונים רק מתוך האפליקציה עצמה' });
      return;
    }
    next();
  });

  api.use(express.json({ limit: '60mb' }));

  // ----- meta -----
  api.get(
    '/bootstrap',
    h(() => ({ today: today(), clockOffsetDays: clockOffset(), settings: getSettings(), courses: listCourses(), counts: queueCounts(), importing: isQueueRunning() })),
  );
  api.get('/settings', h(() => getSettings()));
  api.put('/settings', h((req) => updateSettings(req.body)));
  api.post(
    '/clock',
    h((req) => {
      const days = Number(req.body?.offsetDays ?? 0);
      if (!Number.isInteger(days) || Math.abs(days) > 3650) throw new UserError('היסט לא תקין');
      setClockOffsetDays(days);
      return { today: today(), clockOffsetDays: clockOffset() };
    }),
  );

  // ----- today -----
  api.get('/today', h((req) => getToday({ beyond: req.query.beyond === '1' })));
  api.post('/reviews', h((req) => submitReview(req.body)));

  // ----- courses, topics, lessons -----
  api.get('/courses', h((req) => listCourses(req.query.all === '1')));
  api.post('/courses', h((req) => createCourse(req.body)));
  api.get('/courses/:id', h((req) => getCourse(id(req))));
  api.put('/courses/:id', h((req) => updateCourse(id(req), req.body)));
  api.get(
    '/courses/:id/tree',
    h((req) => {
      const cid = id(req);
      return { course: getCourse(cid), topics: topicsForCourse(cid), units: unitsForCourse(cid), lessons: lessonsForCourse(cid), merged: topicsForCourse(cid, ['merged']) };
    }),
  );
  api.post('/topics', h((req) => createTopic(req.body)));
  api.put('/topics/:id', h((req) => updateTopic(id(req), req.body)));
  api.post('/topics/:id/merge', h((req) => mergeTopics(id(req), Number(req.body?.intoId))));
  api.post('/topics/:id/approve', h((req) => setTopicStatus(id(req), 'active')));
  api.post('/topics/:id/reject', h((req) => setTopicStatus(id(req), 'rejected')));
  api.post('/lessons', h((req) => createLesson(req.body)));
  api.put('/lessons/:id', h((req) => updateLesson(id(req), req.body)));

  // ----- units, questions, links -----
  api.post('/units', h((req) => createUnit(req.body)));
  api.get('/units/:id', h((req) => getUnitDetail(id(req))));
  api.put('/units/:id', h((req) => updateUnit(id(req), req.body)));
  api.post('/units/:id/restart', h((req) => restartUnit(id(req))));
  api.post('/units/:id/approve', h((req) => approveUnit(id(req))));
  api.post('/units/:id/reject', h((req) => (rejectUnit(id(req)), { ok: true })));
  api.post('/questions', h((req) => createQuestion(req.body)));
  api.get('/questions/:id', h((req) => getQuestion(id(req))));
  api.put('/questions/:id', h((req) => updateQuestion(id(req), req.body)));
  api.post('/questions/:id/approve', h((req) => approveQuestion(id(req), req.body ?? {})));
  api.post('/questions/:id/reject', h((req) => rejectQuestion(id(req), req.body ?? {})));
  api.post(
    '/questions/bulk',
    h((req) => {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
      const action = req.body?.action === 'reject' ? 'reject' : 'approve';
      return bulkQuestions(ids, action, req.body ?? {});
    }),
  );
  api.post('/links', h((req) => addLink(req.body)));
  api.post('/links/:id/resolve', h((req) => resolveConflict(id(req), req.body ?? {})));
  api.delete('/links/:id', h((req) => (removeLink(id(req)), { ok: true })));

  // ----- review queue & AI -----
  api.get('/review-queue', h(() => reviewQueue()));
  api.get('/ai/status', h(async () => {
    const p = getProvider(getSettings());
    return { id: p.id, label: p.label, ...(await p.available()) };
  }));
  api.post(
    '/ai/suggest',
    h((req) => {
      const task = req.body?.task === 'topics' ? 'topics' : 'units';
      return suggestFromSource(Number(req.body?.sourceId), task, {
        chunkIds: Array.isArray(req.body?.chunkIds) ? req.body.chunkIds.map(Number) : undefined,
        topicHint: typeof req.body?.topicHint === 'string' ? req.body.topicHint : null,
      });
    }),
  );

  // ----- sources / import -----
  api.get('/sources', h((req) => listSources(req.query.courseId ? Number(req.query.courseId) : null)));
  api.get('/sources/:id', h((req) => ({ source: getSource(id(req)), chunks: getChunks(id(req)) })));
  api.put('/sources/:id', h((req) => updateSource(id(req), req.body)));
  api.post('/sources/:id/extract', h((req) => extractSource(id(req))));
  api.post('/sources/:id/approve', h((req) => setSourceStatus(id(req), 'approve')));
  api.post('/sources/:id/ignore', h((req) => setSourceStatus(id(req), 'ignore')));
  api.post('/sources/:id/restore', h((req) => setSourceStatus(id(req), 'restore')));
  api.get('/sources/:id/file', (req, res, next) => {
    try {
      const f = sourceFile(id(req));
      res.setHeader('Content-Type', f.mime);
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
      fs.createReadStream(f.path).pipe(res);
    } catch (e) {
      next(e);
    }
  });
  api.post(
    '/sources/scan',
    h(() => {
      const r = scanFolders();
      void processQueue();
      return r;
    }),
  );
  api.post(
    '/sources/upload',
    express.raw({ type: '*/*', limit: '200mb' }),
    h((req) => {
      const name = decodeURIComponent(String(req.headers['x-filename'] ?? ''));
      if (!name) throw new UserError('חסר שם קובץ');
      const meta = JSON.parse(decodeURIComponent(String(req.headers['x-meta'] ?? '%7B%7D'))) as Record<string, unknown>;
      return uploadSource(req.body as Buffer, name, meta);
    }),
  );
  api.post('/sources/manual', h((req) => createManualSource(req.body)));
  api.get('/chunks/search', h((req) => searchChunks(String(req.query.q ?? ''), req.query.courseId ? Number(req.query.courseId) : null)));
  api.get('/chunks/:id', h((req) => getChunk(id(req))));
  api.post('/import/cards/preview', h((req) => previewCards(String(req.body?.text ?? ''), { termSep: req.body?.termSep, cardSep: req.body?.cardSep })));
  api.post('/import/cards', h((req) => importCards(req.body)));

  // ----- calendar & progress -----
  api.get(
    '/calendar',
    h((req) => {
      const from = String(req.query.from ?? '');
      const to = String(req.query.to ?? '');
      if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw new UserError('טווח תאריכים לא תקין');
      return calendar(from, to);
    }),
  );
  api.get(
    '/calendar/day',
    h((req) => {
      const date = String(req.query.date ?? '');
      if (!isIsoDate(date)) throw new UserError('תאריך לא תקין');
      return calendarDay(date);
    }),
  );
  api.get('/progress', h(() => progress()));

  // ----- audit, backups, export -----
  api.get('/audit', h((req) => listAudit(Math.min(500, Number(req.query.limit ?? 100)), Number(req.query.offset ?? 0))));
  api.post('/audit/:id/undo', h((req) => undoAction(id(req), { force: Boolean(req.body?.force) })));
  api.get('/backups', h(() => listBackups()));
  api.post('/backups', h(() => backupNow('manual')));
  api.post('/backups/restore', h((req) => restoreFromBackup(String(req.body?.file ?? ''))));
  api.post(
    '/backups/upload',
    express.raw({ type: '*/*', limit: '500mb' }),
    h((req) => {
      const name = decodeURIComponent(String(req.headers['x-filename'] ?? ''));
      const buf = req.body as Buffer;
      if (name.toLowerCase().endsWith('.json')) return { restored: restoreFromJson(JSON.parse(buf.toString('utf8'))) };
      const saved = saveUploadedBackup(buf);
      return { saved, restored: restoreFromBackup(saved.file) };
    }),
  );
  api.get('/export/json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="memory-export-${today()}.json"`);
    res.send(JSON.stringify(exportJson()));
  });
  api.get('/export/excel', async (_req, res, next) => {
    try {
      const buf = await buildWorkbook();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="memory-report-${today()}.xlsx"`);
      res.send(buf);
    } catch (e) {
      next(e);
    }
  });
  api.post('/maintenance/auto-backup', h(() => ({ made: autoBackupIfNeeded() })));

  api.use((_req, res) => {
    res.status(404).json({ error: 'נתיב API לא קיים' });
  });

  app.use('/api', api);

  if (fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
  } else {
    app.get('/', (_req, res) => {
      res
        .type('html')
        .send('<p dir="rtl" style="font-family:sans-serif">הממשק עוד לא נבנה. הרץ <code>npm run build</code> ואז רענן.</p>');
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as Error & { status?: number; type?: string };
    if (e instanceof UserError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: 'הקובץ גדול מדי' });
      return;
    }
    if (e?.type === 'entity.parse.failed' || e instanceof SyntaxError) {
      res.status(400).json({ error: 'בקשה לא תקינה (JSON שבור)' });
      return;
    }
    const msg = String(e?.message ?? e);
    if (msg.includes('UNIQUE constraint failed')) {
      res.status(409).json({ error: 'הפעולה יוצרת כפילות של קישור שכבר קיים.' });
      return;
    }
    if (msg.includes('FOREIGN KEY constraint failed')) {
      res.status(409).json({ error: 'הפעולה נחסמה כי רשומות אחרות תלויות ברשומה הזו. אפשר לשחזר מגיבוי אם צריך.' });
      return;
    }
    console.error(e);
    res.status(500).json({ error: `שגיאה פנימית: ${msg}` });
  });

  return app;
}
