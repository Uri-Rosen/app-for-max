// Import → extraction → AI proposals → approval, through the real services.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-pipeline-'));
process.env.MEMORY_DATA_DIR = dir;

let db: typeof import('../server/db/index.ts');
let audit: typeof import('../server/audit.ts');
let S: typeof import('../server/services/structure.ts');
let U: typeof import('../server/services/units.ts');
let src: typeof import('../server/services/sources.ts');
let P: typeof import('../server/services/proposals.ts');
let session: typeof import('../server/services/session.ts');

beforeAll(async () => {
  db = await import('../server/db/index.ts');
  audit = await import('../server/audit.ts');
  S = await import('../server/services/structure.ts');
  U = await import('../server/services/units.ts');
  src = await import('../server/services/sources.ts');
  P = await import('../server/services/proposals.ts');
  session = await import('../server/services/session.ts');
});

afterAll(() => {
  db.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

let courseId = 0;
beforeEach(() => {
  db.openDb(path.join(dir, `p-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
  courseId = S.createCourse({ name: 'פיזיולוגיה' }).id;
});

const md = (s: string) => Buffer.from(s, 'utf8');
const LESSON = '# שיעור 2 — הורמונים\n\nאינסולין – הורמון שמופרש מתאי בטא בלבלב ומוריד את רמת הסוכר בדם.\n\nגלוקגון – הורמון שמופרש מתאי אלפא בלבלב ומעלה את רמת הסוכר בדם.\n';

async function approvedSource(name: string, text: string, kind: string) {
  const s = await src.uploadSource(md(text), name, { courseId, kind, studiedOn: '2026-09-20' });
  expect(s.status).toBe('extracted');
  return src.setSourceStatus(s.id, 'approve');
}

describe('AI proposals', () => {
  it('proposes grounded units and questions that stay out of the schedule until approved', async () => {
    const s = await approvedSource('שיעור 2.md', LESSON, 'lesson_summary');
    const r = await P.suggestFromSource(s.id, 'units', { topicHint: 'הורמונים' });
    expect(r.units).toBeGreaterThanOrEqual(2);
    expect(r.failedValidation).toBe(0);

    const q = P.reviewQueue();
    const insulin = q.units.find((u) => u.unit.title === 'אינסולין')!;
    expect(insulin.unit.status).toBe('proposed');
    expect(insulin.questions.every((x) => x.status === 'pending' && x.createdBy === 'ai' && x.links.length > 0)).toBe(true);
    expect(session.getToday().queue).toHaveLength(0);

    const first = insulin.questions[0];
    expect(() => U.approveQuestion(first.id, {})).toThrow();
    U.approveQuestion(first.id, { verified: true });
    const detail = U.getUnitDetail(insulin.unit.id);
    expect(detail.unit.status).toBe('active');
    expect(detail.unit.dueDate).toBe('2026-09-20');
    expect(detail.questions.find((x) => x.id === first.id)!.verifiedAt).toBeTruthy();
  });

  it('flags a definition that contradicts another source (opposite direction)', async () => {
    const a = await approvedSource('שיעור 2.md', LESSON, 'lesson_summary');
    await P.suggestFromSource(a.id, 'units', { topicHint: 'הורמונים' });
    const insulinA = P.reviewQueue().units.find((u) => u.unit.title === 'אינסולין')!;
    U.approveQuestion(insulinA.questions[0].id, { verified: true });

    const b = await approvedSource('סיכום.md', '# סיכום\n\nאינסולין – הורמון שמעלה את רמת הסוכר בדם.\n', 'student_summary');
    const r = await P.suggestFromSource(b.id, 'units', { topicHint: 'הורמונים' });
    // Same title → no duplicate unit; the contradiction lands on the existing one.
    expect(r.units).toBe(0);
    expect(r.conflicts).toBe(1);

    const d = U.getUnitDetail(insulinA.unit.id);
    expect(d.unit.unverified).toBe(true);
    expect(d.questions.find((x) => x.id === insulinA.questions[0].id)!.status).toBe('flagged');
    const conflict = P.reviewQueue().conflicts.find((c) => c.unitId === insulinA.unit.id)!;
    expect(conflict.link.note).toContain('הפוך');
    expect(session.getToday().blocked.map((x) => x.unitId)).toContain(insulinA.unit.id);

    U.resolveConflict(conflict.link.id, { note: 'הסיכום טעה — אינסולין מוריד סוכר' });
    expect(U.getUnitDetail(insulinA.unit.id).questions.find((x) => x.id === insulinA.questions[0].id)!.status).toBe('approved');
  });

  it('does not raise a conflict when another source agrees', async () => {
    const a = await approvedSource('שיעור 2.md', LESSON, 'lesson_summary');
    await P.suggestFromSource(a.id, 'units', { topicHint: 'הורמונים' });
    const b = await approvedSource('מצגת.md', '# מצגת\n\nאינסולין – הורמון שמופרש מתאי בטא בלבלב ומוריד את רמת הסוכר בדם.\n', 'slides');
    expect((await P.suggestFromSource(b.id, 'units', { topicHint: 'הורמונים' })).conflicts).toBe(0);
  });

  it('undoing a suggestion run removes every proposal it made', async () => {
    const s = await approvedSource('שיעור 2.md', LESSON, 'lesson_summary');
    const r = await P.suggestFromSource(s.id, 'units', { topicHint: 'הורמונים' });
    expect(P.queueCounts().units).toBeGreaterThan(0);
    expect(audit.undoAction(r.auditId!).ok).toBe(true);
    const c = P.queueCounts();
    expect(c.units).toBe(0);
    expect(c.pending).toBe(0);
  });

  it('refuses to suggest from a source that was not approved', async () => {
    const s = await src.uploadSource(md(LESSON), 'x.md', { courseId });
    await expect(P.suggestFromSource(s.id, 'units')).rejects.toThrow(/אושר/);
  });

  it('proposes syllabus topics once, without duplicating existing ones', async () => {
    S.createTopic({ courseId, name: 'מבוא לתא' });
    const s = await approvedSource('סילבוס.md', '# סילבוס\n\nשבוע 1: מבוא לתא\nשבוע 2: ממברנות\nשבוע 3: איתות תאי\n', 'syllabus');
    const r = await P.suggestFromSource(s.id, 'topics');
    expect(r.topics).toBe(2);
    const names = P.reviewQueue().topics.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['ממברנות', 'איתות תאי']));
    expect(P.reviewQueue().topics.every((t) => t.createdBy === 'syllabus' && t.syllabusOrder !== null)).toBe(true);
  });
});

describe('Quizlet cards', () => {
  it('imports cards as scheduled units in one undoable action', () => {
    const r = P.importCards({
      courseId,
      topicName: 'מונחים',
      learnedOn: '2026-09-20',
      provenance: 'official',
      text: 'מיטוכונדריה\tנשימה תאית\nריבוזום\tתרגום\nהנשא ____ מכניס גלוקוז\tGLUT4\nשורה בלי מפריד',
    });
    expect(r.units).toBe(3);
    expect(r.skipped).toBe(1);
    const cloze = U.getUnitDetail(r.unitIds[2]).questions[0];
    expect(cloze.kind).toBe('cloze');
    expect(cloze.prompt).toBe('הנשא [[GLUT4]] מכניס גלוקוז');
    expect(session.getToday().totalDue).toBe(3);
    expect(audit.undoAction(r.auditId!).ok).toBe(true);
    expect(session.getToday().totalDue).toBe(0);
  });

  it('can hold imported cards for review first', () => {
    P.importCards({ courseId, text: 'a\tb\nc\td', reviewFirst: true });
    expect(P.queueCounts().pending).toBe(2);
    expect(session.getToday().blocked).toHaveLength(2);
  });
});

describe('sources', () => {
  it('detects a duplicate upload and duplicate pages', async () => {
    const a = await src.uploadSource(md(LESSON), 'a.md', { courseId });
    const b = await src.uploadSource(md(LESSON), 'b.md', { courseId });
    expect(b.duplicateOf).toBe(a.id);
    expect(b.dupChunkCount).toBe(b.chunkCount);
  });

  it('scans a course folder: new, changed (new version), missing — and never modifies files', () => {
    const folder = path.join(dir, `course-${Date.now()}`);
    fs.mkdirSync(folder);
    const f = path.join(folder, 'הרצאה 1.md');
    fs.writeFileSync(f, LESSON);
    fs.writeFileSync(path.join(folder, '~$lock.docx'), 'x');
    S.updateCourse(courseId, { watchFolder: folder });

    let r = src.scanFolders();
    expect(r.added).toBe(1);
    const before = fs.readFileSync(f);
    r = src.scanFolders();
    expect(r.unchanged).toBe(1);

    fs.writeFileSync(f, `${LESSON}\nעוד שורה.\n`);
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    r = src.scanFolders();
    expect(r.changed).toBe(1);
    const versions = src.listSources(courseId);
    expect(versions).toHaveLength(2);
    expect(versions[0].previousVersionId).toBe(versions[1].id);
    expect(versions[1].status).toBe('changed');

    fs.rmSync(f);
    r = src.scanFolders();
    expect(r.missing).toBe(1);
    expect(before.length).toBeGreaterThan(0);
  });

  it('will not re-extract a source whose text is cited', async () => {
    const s = await approvedSource('שיעור 2.md', LESSON, 'lesson_summary');
    await P.suggestFromSource(s.id, 'units', { topicHint: 'הורמונים' });
    await expect(src.extractSource(s.id)).rejects.toThrow(/מצטטות/);
  });
});
