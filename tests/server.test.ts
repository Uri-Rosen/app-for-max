// End-to-end through the service layer against a real SQLite file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
process.env.MEMORY_DATA_DIR = dir;

type Mods = {
  db: typeof import('../server/db/index.ts');
  audit: typeof import('../server/audit.ts');
  structure: typeof import('../server/services/structure.ts');
  units: typeof import('../server/services/units.ts');
  session: typeof import('../server/services/session.ts');
  settings: typeof import('../server/services/settings.ts');
  backup: typeof import('../server/services/backup.ts');
  stats: typeof import('../server/services/stats.ts');
};
let m: Mods;

beforeAll(async () => {
  m = {
    db: await import('../server/db/index.ts'),
    audit: await import('../server/audit.ts'),
    structure: await import('../server/services/structure.ts'),
    units: await import('../server/services/units.ts'),
    session: await import('../server/services/session.ts'),
    settings: await import('../server/services/settings.ts'),
    backup: await import('../server/services/backup.ts'),
    stats: await import('../server/services/stats.ts'),
  };
});

afterAll(() => {
  m.db.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

let dbFile = '';
beforeEach(() => {
  dbFile = path.join(dir, `t-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  m.db.openDb(dbFile);
  m.settings.setClockOffsetDays(0);
});

function seed(nUnits = 3, learnedOffset = 0) {
  const course = m.structure.createCourse({ name: 'ביולוגיה של התא' });
  const topic = m.structure.createTopic({ courseId: course.id, name: 'איתות תאי', importance: 'core' });
  const learnedOn = m.settings.today();
  const units = [];
  for (let i = 0; i < nUnits; i++) {
    units.push(
      m.units.createUnit({
        topicId: topic.id,
        title: `מושג ${i + 1}`,
        content: `הגדרה ${i + 1}`,
        learnedOn: learnedOffset ? shift(learnedOn, learnedOffset) : learnedOn,
        questions: [{ kind: 'definition', prompt: `מהו מושג ${i + 1}?`, answer: `הגדרה ${i + 1}` }],
      }),
    );
  }
  return { course, topic, units };
}

function shift(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function answer(unitId: number, grade: 'wrong' | 'partial' | 'correct' | 'easy', extra: Record<string, unknown> = {}) {
  const t = m.session.getToday();
  const item = [...t.queue, ...t.deferred].find((q) => q.unitId === unitId)!;
  return m.session.submitReview({ unitId, questionId: item.question!.id, grade, totalMs: 20_000, answerMs: 15_000, ...extra });
}

describe('daily session', () => {
  it('new units are due on the day they were learned, with reasons', () => {
    const { units } = seed(3);
    const t = m.session.getToday();
    expect(t.queue.map((q) => q.unitId).sort()).toEqual(units.map((u) => u.unit.id).sort());
    expect(t.queue[0].reasons.some((r) => r.code === 'new')).toBe(true);
    expect(t.queue[0].reasons.some((r) => r.code === 'core')).toBe(true);
    expect(t.queue[0].questionWhy).toBeTruthy();
  });

  it('answering moves the unit forward and records history', () => {
    const { units } = seed(1);
    const id = units[0].unit.id;
    const r = answer(id, 'correct');
    expect(r.intervalDays).toBe(1);
    expect(r.explanation.lines.length).toBeGreaterThan(0);
    const detail = m.units.getUnitDetail(id);
    expect(detail.unit.dueDate).toBe(shift(m.settings.today(), 1));
    expect(detail.reviews).toHaveLength(1);
    expect(detail.reviews[0].gapDays).toBe(0);
    expect(m.session.getToday().queue).toHaveLength(0);
    expect(m.session.getToday().tomorrow.count).toBe(1);
  });

  it('a wrong answer queues one in-session correction that does not move the schedule', () => {
    const { units } = seed(1);
    const id = units[0].unit.id;
    answer(id, 'wrong', { errorType: 'knowledge_gap' });
    const t = m.session.getToday();
    expect(t.corrections).toHaveLength(1);
    const due = m.units.getUnitDetail(id).unit.dueDate;
    m.session.submitReview({ unitId: id, questionId: t.corrections[0].question!.id, grade: 'correct', isCorrection: true, totalMs: 5000 });
    expect(m.session.getToday().corrections).toHaveLength(0);
    expect(m.units.getUnitDetail(id).unit.dueDate).toBe(due);
  });

  it('overflow beyond the budget is deferred, visible, and carried to tomorrow', () => {
    m.settings.updateSettings({ maxItems: 4 });
    seed(10);
    const t = m.session.getToday();
    expect(t.queue).toHaveLength(4);
    expect(t.deferred).toHaveLength(6);
    expect(t.deferred.every((d) => d.deferReason)).toBe(true);
    expect(t.totalDue).toBe(10);
    // Skip the day entirely: tomorrow they are all still there, now overdue.
    m.settings.setClockOffsetDays(1);
    const t2 = m.session.getToday();
    expect(t2.queue.length + t2.deferred.length).toBe(10);
    expect(t2.queue[0].reasons.some((r) => r.code === 'overdue')).toBe(true);
    // And the calendar/progress know yesterday's reviews were missed.
    const p = m.stats.progress();
    expect(p.completion.due).toBe(10);
    expect(p.completion.done).toBe(0);
  });

  it('missed days pile up as overdue, never vanish', () => {
    const { units } = seed(2);
    answer(units[0].unit.id, 'correct');
    answer(units[1].unit.id, 'correct');
    m.settings.setClockOffsetDays(9);
    const t = m.session.getToday();
    expect(t.queue.map((q) => q.unitId).sort()).toEqual(units.map((u) => u.unit.id).sort());
    expect(t.queue[0].reasons.find((r) => r.code === 'overdue')!.text).toContain('8');
  });

  it('days the app was never opened still count as missed reviews', () => {
    const { units } = seed(2);
    answer(units[0].unit.id, 'correct');
    answer(units[1].unit.id, 'correct');
    // Both due tomorrow (day 1). The app stays closed on days 1–3.
    m.settings.setClockOffsetDays(4);
    m.session.getToday();
    const p = m.stats.progress();
    // Day 0: 2 due, 2 done. Days 1–3: 2 due each, none done.
    expect(p.completion.due).toBe(8);
    expect(p.completion.done).toBe(2);
    const cal = m.stats.calendar(shift(m.settings.today(), -4), m.settings.today());
    expect(cal.filter((c) => c.deferred === 2)).toHaveLength(3);
  });

  it('hints are recorded and reduce credit', () => {
    const { units } = seed(1);
    const id = units[0].unit.id;
    answer(id, 'correct');
    m.settings.setClockOffsetDays(1);
    const r = answer(id, 'correct', { hintUsed: true });
    expect(r.effectiveGrade).toBe('partial');
    expect(r.intervalDays).toBe(1);
    expect(m.units.getUnitDetail(id).reviews[0].hintUsed).toBe(true);
  });

  it('an unclear question is flagged out of rotation and the unit reports blocked', () => {
    const { units } = seed(1);
    const id = units[0].unit.id;
    answer(id, 'wrong', { errorType: 'unclear_question' });
    const q = m.units.getUnitDetail(id).questions[0];
    expect(q.status).toBe('flagged');
    m.settings.setClockOffsetDays(1);
    const t = m.session.getToday();
    expect(t.queue).toHaveLength(0);
    expect(t.blocked).toHaveLength(1);
    expect(t.blocked[0].reason).toContain('בדיקה');
  });
});

describe('undo and the action log', () => {
  it('undoing a review restores the unit exactly', () => {
    const { units } = seed(1);
    const id = units[0].unit.id;
    const before = m.units.getUnitDetail(id).unit;
    const r = answer(id, 'easy');
    expect(r.auditId).toBeTruthy();
    const res = m.audit.undoAction(r.auditId!);
    expect(res.ok).toBe(true);
    const after = m.units.getUnitDetail(id);
    expect(after.unit.dueDate).toBe(before.dueDate);
    expect(after.unit.step).toBe(before.step);
    expect(after.reviews).toHaveLength(0);
  });

  it('refuses to undo an older review once a newer one changed the unit', () => {
    const { units } = seed(1);
    const id = units[0].unit.id;
    const r1 = answer(id, 'correct');
    m.settings.setClockOffsetDays(1);
    answer(id, 'correct');
    const res = m.audit.undoAction(r1.auditId!);
    expect(res.ok).toBe(false);
    expect(res.conflicts.length).toBeGreaterThan(0);
  });

  it('undo of an undo re-applies the action', () => {
    const { topic } = seed(0);
    m.structure.updateTopic(topic.id, { name: 'איתות' });
    const log = m.audit.listAudit(5);
    const rename = log.find((l) => l.action === 'topic.update')!;
    const u1 = m.audit.undoAction(rename.id);
    expect(m.structure.getTopic(topic.id).name).toBe('איתות תאי');
    m.audit.undoAction(u1.auditId!);
    expect(m.structure.getTopic(topic.id).name).toBe('איתות');
  });
});

describe('topic structure', () => {
  it('merging keeps the old name as an alias, moves units, preserves review history, and is undoable', () => {
    const course = m.structure.createCourse({ name: 'פיזיולוגיה' });
    const a = m.structure.createTopic({ courseId: course.id, name: 'מערכת העצבים' });
    const b = m.structure.createTopic({ courseId: course.id, name: 'מערכת עצבים' });
    const lesson = m.structure.createLesson({ courseId: course.id, title: 'הרצאה 3', studiedOn: m.settings.today(), topicIds: [b.id] });
    const unit = m.units.createUnit({ topicId: b.id, title: 'נוירון', learnedOn: m.settings.today(), questions: [{ kind: 'definition', prompt: 'נוירון', answer: 'תא עצב' }] });
    answer(unit.unit.id, 'correct');

    const merged = m.structure.mergeTopics(b.id, a.id);
    expect(merged.aliases.map((x) => x.alias)).toContain('מערכת עצבים');
    expect(merged.lessonIds).toContain(lesson.id);
    const detail = m.units.getUnitDetail(unit.unit.id);
    expect(detail.topic.id).toBe(a.id);
    expect(detail.unit.originalTopicId).toBe(b.id);
    expect(detail.reviews).toHaveLength(1);

    const entry = m.audit.listAudit(3).find((l) => l.action === 'topic.merge')!;
    expect(m.audit.undoAction(entry.id).ok).toBe(true);
    expect(m.units.getUnitDetail(unit.unit.id).topic.id).toBe(b.id);
    expect(m.structure.getTopic(b.id).status).toBe('active');
  });

  it('one lesson can cover several topics, and a topic several lessons', () => {
    const course = m.structure.createCourse({ name: 'גנטיקה' });
    const t1 = m.structure.createTopic({ courseId: course.id, name: 'שכפול DNA' });
    const t2 = m.structure.createTopic({ courseId: course.id, name: 'תיקון DNA' });
    m.structure.createLesson({ courseId: course.id, title: 'שיעור 1', studiedOn: '2026-10-01', topicIds: [t1.id, t2.id] });
    m.structure.createLesson({ courseId: course.id, title: 'שיעור 2', studiedOn: '2026-10-05', topicIds: [t1.id] });
    const topics = m.structure.topicsForCourse(course.id);
    expect(topics.find((t) => t.id === t1.id)!.lessonIds).toHaveLength(2);
    expect(topics.find((t) => t.id === t2.id)!.lessonIds).toHaveLength(1);
  });

  it('prevents topic cycles', () => {
    const course = m.structure.createCourse({ name: 'x' });
    const p = m.structure.createTopic({ courseId: course.id, name: 'אב' });
    const c = m.structure.createTopic({ courseId: course.id, name: 'בן', parentId: p.id });
    expect(() => m.structure.updateTopic(p.id, { parentId: c.id })).toThrow();
  });
});

describe('questions and sources', () => {
  it('cloze needs a marked blank', () => {
    const { units } = seed(1);
    expect(() => m.units.createQuestion({ unitId: units[0].unit.id, kind: 'cloze', prompt: 'אין כאן חסר', answer: 'x' })).toThrow(/\[\[/);
    const q = m.units.createQuestion({ unitId: units[0].unit.id, kind: 'cloze', prompt: 'ההורמון [[אינסולין]] מוריד סוכר', answer: '' });
    expect(q.answer).toBe('אינסולין');
  });

  it('pathway answers keep source → signal → target → outcome order', () => {
    const { units } = seed(1);
    const q = m.units.createQuestion({
      unitId: units[0].unit.id,
      kind: 'recall',
      prompt: 'תאר את מסלול האינסולין',
      answer: 'לבלב → אינסולין → קולטן בשריר → קליטת גלוקוז',
      structure: { template: 'pathway', fields: { outcome: 'קליטת גלוקוז', source: 'תאי בטא', signal: 'אינסולין', target: 'קולטן אינסולין' } },
    });
    expect(Object.keys(q.structure!.fields)).toEqual(['source', 'signal', 'target', 'outcome']);
  });

  it('AI questions cannot be approved without the source check', () => {
    const { units } = seed(1);
    const { result: qid } = m.audit.record({ action: 't', summary: 't' }, (cs) =>
      m.units.insertQuestion(cs, { unitId: units[0].unit.id, kind: 'definition', prompt: 'p', answer: 'a' }, { status: 'pending', createdBy: 'ai', provenance: 'generated' }),
    );
    expect(() => m.units.approveQuestion(qid, {})).toThrow(/מול המקור/);
    expect(m.units.approveQuestion(qid, { verified: true }).status).toBe('approved');
  });

  it('a contradicting source pulls questions out of rotation until resolved', () => {
    const { units } = seed(1);
    const id = units[0].unit.id;
    const src = m.db.run(
      "INSERT INTO sources (course_id, kind, title, origin, status, added_at) VALUES (1, 'student_summary', 'סיכום', 'manual', 'approved', 'x')",
    ).lastId;
    const link = m.units.addLink({ entityType: 'unit', entityId: id, sourceId: src, role: 'contradicts', quote: 'הגדרה אחרת' });
    expect(m.units.getUnitDetail(id).questions[0].status).toBe('flagged');
    expect(m.units.getUnitDetail(id).unit.unverified).toBe(true);
    expect(m.session.getToday().blocked).toHaveLength(1);
    m.units.resolveConflict(link.id, { note: 'הסיכום טעה' });
    expect(m.units.getUnitDetail(id).questions[0].status).toBe('approved');
  });

  it('linking an official source upgrades an unverified question', () => {
    const { units } = seed(1);
    const id = units[0].unit.id;
    const src = m.db.run("INSERT INTO sources (course_id, kind, title, origin, status, added_at) VALUES (1, 'slides', 'מצגת 1', 'manual', 'approved', 'x')").lastId;
    m.units.addLink({ entityType: 'unit', entityId: id, sourceId: src, role: 'supports', locator: 'שקופית 4' });
    const d = m.units.getUnitDetail(id);
    expect(d.questions[0].provenance).toBe('official');
    expect(d.unit.unverified).toBe(false);
  });
});

describe('backup and restore', () => {
  it('restores from a database backup after damage, keeping a safety copy', () => {
    const { units } = seed(2);
    const b = m.backup.backupNow('manual');
    answer(units[0].unit.id, 'correct');
    m.units.updateUnit(units[1].unit.id, { status: 'archived' });
    const res = m.backup.restoreFromBackup(b.file);
    expect(res.safety.kind).toBe('pre-restore');
    expect(m.units.getUnitDetail(units[0].unit.id).reviews).toHaveLength(0);
    expect(m.units.getUnitDetail(units[1].unit.id).unit.status).toBe('active');
    expect(m.backup.listBackups().some((x) => x.file === res.safety.file)).toBe(true);
  });

  it('round-trips through the JSON export', () => {
    const { units } = seed(2);
    answer(units[0].unit.id, 'easy');
    const json = JSON.parse(JSON.stringify(m.backup.exportJson()));
    m.units.updateUnit(units[0].unit.id, { title: 'שונה' });
    const res = m.backup.restoreFromJson(json);
    expect(res.counts.reviews).toBe(1);
    const d = m.units.getUnitDetail(units[0].unit.id);
    expect(d.unit.title).toBe('מושג 1');
    expect(d.reviews).toHaveLength(1);
    expect(d.unit.step).toBe(1);
  });

  it('rejects a file that is not a backup', () => {
    const bad = path.join(dir, 'backups', 'manual-bad.db');
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    fs.writeFileSync(bad, 'not a database');
    expect(() => m.backup.restoreFromBackup('manual-bad.db')).toThrow();
    expect(() => m.backup.restoreFromBackup('../memory.db')).toThrow();
    expect(() => m.backup.restoreFromJson({ hello: 1 })).toThrow();
  });
});

describe('progress', () => {
  it('measures retention after long gaps separately', () => {
    const { units } = seed(1);
    const id = units[0].unit.id;
    answer(id, 'easy'); // → 3 days
    m.settings.setClockOffsetDays(3);
    answer(id, 'easy'); // → 14 days
    m.settings.setClockOffsetDays(17);
    answer(id, 'correct'); // gap 14
    const p = m.stats.progress();
    expect(p.retentionWeek.total).toBe(1);
    expect(p.retentionWeek.rate).toBe(1);
    expect(p.buckets.find((b) => b.min === 14)!.total).toBe(1);
  });
});
