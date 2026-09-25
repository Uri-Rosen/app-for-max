// One test per defect found in the code review, so each stays fixed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-regress-'));
process.env.MEMORY_DATA_DIR = dir;

let db: typeof import('../server/db/index.ts');
let audit: typeof import('../server/audit.ts');
let S: typeof import('../server/services/structure.ts');
let U: typeof import('../server/services/units.ts');
let src: typeof import('../server/services/sources.ts');
let P: typeof import('../server/services/proposals.ts');
let session: typeof import('../server/services/session.ts');
let settings: typeof import('../server/services/settings.ts');
let stats: typeof import('../server/services/stats.ts');
let backup: typeof import('../server/services/backup.ts');

beforeAll(async () => {
  db = await import('../server/db/index.ts');
  audit = await import('../server/audit.ts');
  S = await import('../server/services/structure.ts');
  U = await import('../server/services/units.ts');
  src = await import('../server/services/sources.ts');
  P = await import('../server/services/proposals.ts');
  session = await import('../server/services/session.ts');
  settings = await import('../server/services/settings.ts');
  stats = await import('../server/services/stats.ts');
  backup = await import('../server/services/backup.ts');
});

afterAll(() => {
  db.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

let courseId = 0;
let topicId = 0;
beforeEach(() => {
  db.openDb(path.join(dir, `r-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
  settings.setClockOffsetDays(0);
  courseId = S.createCourse({ name: 'קורס' }).id;
  topicId = S.createTopic({ courseId, name: 'נושא' }).id;
});

const LESSON = '# שיעור\n\nאינסולין – הורמון שמופרש מתאי בטא בלבלב ומוריד את רמת הסוכר בדם.\n';
const lastAudit = (action: string) => audit.listAudit(20).find((a) => a.action === action && !a.undone_at)!;
function unit(title = 'יחידה', questions = [{ kind: 'definition', prompt: 'ש', answer: 'ת' }]) {
  return U.createUnit({ topicId, title, learnedOn: settings.today(), questions }).unit.id;
}
function manualSource(kind = 'student_summary'): number {
  return db.run("INSERT INTO sources (course_id, kind, title, origin, status, added_at) VALUES (?, ?, 'מקור', 'manual', 'approved', 'x')", courseId, kind).lastId;
}

describe('undo', () => {
  it('will not leave a later source link orphaned when undoing a creation', () => {
    const id = unit();
    const created = lastAudit('unit.create');
    U.addLink({ entityType: 'unit', entityId: id, sourceId: manualSource(), role: 'contradicts', quote: 'אחרת' });
    const r = audit.undoAction(created.id);
    expect(r.ok).toBe(false);
    expect(r.conflicts.some((c) => c.table === 'source_links')).toBe(true);
    // Forced, the link goes with its unit instead of haunting the next one to reuse the id.
    expect(audit.undoAction(created.id, { force: true }).ok).toBe(true);
    expect(db.all("SELECT * FROM source_links WHERE entity_type = 'unit' AND entity_id = ?", id)).toHaveLength(0);
    const next = unit('יחידה חדשה');
    const d = U.getUnitDetail(next);
    expect(d.links).toHaveLength(0);
    expect(d.questions[0].status).toBe('approved');
  });

  it('collapses repeated changes to one row so an immediate undo is clean', () => {
    const a = S.createTopic({ courseId, name: 'מערכת העצבים' });
    const b = S.createTopic({ courseId, name: 'מערכת עצבים', importance: 'core', foundational: true });
    S.mergeTopics(b.id, a.id); // updates `a` twice: importance and foundational
    expect(audit.undoAction(lastAudit('topic.merge').id).ok).toBe(true);
    expect(S.getTopic(a.id).importance).toBe('normal');
  });

  it('reports a re-created lesson link as a conflict instead of crashing', () => {
    const l = S.createLesson({ courseId, title: 'שיעור', studiedOn: settings.today(), topicIds: [topicId] });
    S.updateLesson(l.id, { topicIds: [] });
    const removal = lastAudit('lesson.update');
    S.updateLesson(l.id, { topicIds: [topicId] });
    const r = audit.undoAction(removal.id);
    expect(r.ok).toBe(false);
    expect(() => audit.undoAction(removal.id, { force: true })).not.toThrow();
    expect(db.all('SELECT * FROM lesson_topics WHERE lesson_id = ?', l.id)).toHaveLength(1);
  });
});

describe('sources', () => {
  it('a folder file that goes missing and comes back keeps its approval', async () => {
    const folder = path.join(dir, `f-${Date.now()}`);
    fs.mkdirSync(folder);
    const f = path.join(folder, 'שיעור.md');
    fs.writeFileSync(f, LESSON);
    S.updateCourse(courseId, { watchFolder: folder });
    src.scanFolders();
    const id = src.listSources(courseId)[0].id;
    await src.extractSource(id);
    src.setSourceStatus(id, 'approve');

    const moved = `${f}.away`;
    fs.renameSync(f, moved);
    src.scanFolders();
    expect(src.getSource(id).status).toBe('missing');
    fs.renameSync(moved, f);
    src.scanFolders();
    expect(src.getSource(id).status).toBe('approved');
  });

  it('re-extracting a source that another source duplicates works', async () => {
    const a = await src.uploadSource(Buffer.from(LESSON), 'a.md', { courseId });
    const b = await src.uploadSource(Buffer.from(LESSON), 'b.md', { courseId });
    expect(b.dupChunkCount).toBeGreaterThan(0);
    await expect(src.extractSource(a.id)).resolves.toBeTruthy();
    expect(src.getSource(b.id).dupChunkCount).toBe(0);
  });

  it('ignoring a source while it is being extracted sticks', async () => {
    const s = await src.uploadSource(Buffer.from(LESSON), 'a.md', { courseId });
    const pending = src.extractSource(s.id);
    src.setSourceStatus(s.id, 'ignore');
    await pending;
    expect(src.getSource(s.id).status).toBe('ignored');
  });
});

describe('proposals and conflicts', () => {
  it('refuses a second suggestion run on a source that is still running', async () => {
    const s = await src.uploadSource(Buffer.from(LESSON), 'a.md', { courseId, kind: 'lesson_summary' });
    src.setSourceStatus(s.id, 'approve');
    const first = P.suggestFromSource(s.id, 'units');
    await expect(P.suggestFromSource(s.id, 'units')).rejects.toThrow(/כבר רצה/);
    await first;
    expect(P.reviewQueue().units).toHaveLength(1);
  });

  it('removing a contradiction releases the questions it flagged', () => {
    const id = unit();
    const link = U.addLink({ entityType: 'unit', entityId: id, sourceId: manualSource(), role: 'contradicts' });
    expect(U.getUnitDetail(id).questions[0].status).toBe('flagged');
    U.removeLink(link.id);
    expect(U.getUnitDetail(id).questions[0].status).toBe('approved');
  });

  it('does not count flagged questions of archived units', () => {
    const id = unit();
    U.addLink({ entityType: 'unit', entityId: id, sourceId: manualSource(), role: 'contradicts' });
    expect(P.queueCounts().flagged).toBe(1);
    U.updateUnit(id, { status: 'archived' });
    expect(P.queueCounts().flagged).toBe(0);
    expect(S.getCourse(courseId).stats.pending).toBe(0);
  });

  it('treats matching definitions with Hebrew prefix letters as agreeing', async () => {
    const a = await src.uploadSource(Buffer.from(LESSON), 'a.md', { courseId, kind: 'lesson_summary' });
    src.setSourceStatus(a.id, 'approve');
    await P.suggestFromSource(a.id, 'units');
    const b = await src.uploadSource(Buffer.from('# מצגת\n\nאינסולין – ההורמון שמופרש מתאי הבטא שבלבלב ומוריד את רמת הסוכר שבדם.\n'), 'b.md', {
      courseId,
      kind: 'slides',
    });
    src.setSourceStatus(b.id, 'approve');
    expect((await P.suggestFromSource(b.id, 'units')).conflicts).toBe(0);
  });

  it('refuses to merge into a topic that is no longer active', () => {
    const dead = S.createTopic({ courseId, name: 'ישן' });
    S.setTopicStatus(dead.id, 'rejected');
    expect(() => S.mergeTopics(topicId, dead.id)).toThrow(/פעיל/);
  });
});

describe('session and stats', () => {
  it('logs never-opened days even when the first action of a new day is an answer', () => {
    const id = unit();
    const q = U.getUnitDetail(id).questions[0].id;
    session.submitReview({ unitId: id, questionId: q, grade: 'correct', totalMs: 5000 }); // due tomorrow
    settings.setClockOffsetDays(4); // days 1–3 never opened; the tab left open answers on day 4
    session.submitReview({ unitId: id, questionId: q, grade: 'correct', totalMs: 5000 });
    const p = stats.progress();
    expect(p.completion.due).toBe(4); // day 0 + days 1–3
    expect(p.completion.done).toBe(1);
  });

  it('refuses a second answer to a card that is no longer due (two tabs)', () => {
    const id = unit();
    const q = U.getUnitDetail(id).questions[0].id;
    session.submitReview({ unitId: id, questionId: q, grade: 'easy' });
    expect(() => session.submitReview({ unitId: id, questionId: q, grade: 'easy' })).toThrow(/כבר נענתה/);
  });

  it('calendar and Today agree on units that cannot be asked yet', () => {
    U.createUnit({ topicId, title: 'בלי שאלה', learnedOn: settings.today() });
    expect(session.getToday().totalDue).toBe(1);
    const cal = stats.calendar(settings.today(), settings.today());
    expect(cal[0].scheduled).toBe(1);
  });

  it('does not count units that did not exist yet as missed on backfilled days', () => {
    unit();
    session.getToday(); // day 0 logged
    settings.setClockOffsetDays(3);
    // Created on day 3 with a learning date back on day 0.
    U.createUnit({ topicId, title: 'מאוחרת', learnedOn: settings.today().replace(/\d\d$/, (d) => String(Number(d) - 3).padStart(2, '0')), questions: [{ kind: 'definition', prompt: 'a', answer: 'b' }] });
    session.getToday();
    const logs = db.all<{ local_date: string; due_unit_ids: string }>('SELECT * FROM day_log ORDER BY local_date');
    const backfilled = logs.filter((l) => l.local_date !== logs[0].local_date && l.local_date !== settings.today());
    for (const l of backfilled) expect(JSON.parse(l.due_unit_ids)).toHaveLength(1);
  });

  it('a shifted test clock does not write automatic backups', () => {
    settings.setClockOffsetDays(5);
    expect(backup.autoBackupIfNeeded()).toBeNull();
    expect(backup.autoExportIfNeeded()).toBeNull();
  });
});
