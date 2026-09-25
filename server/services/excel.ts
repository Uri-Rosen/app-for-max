// Excel is a report, never the source of truth: this writes a read-only
// snapshot of units, questions, review history, the schedule and progress.

import ExcelJS from 'exceljs';
import { all, type Row } from '../db/index.ts';
import { addDays } from '../../shared/dates.ts';
import {
  CONFIDENCE_LABELS,
  ERROR_LABELS,
  GRADE_LABELS,
  IMPORTANCE_LABELS,
  KIND_LABELS,
  PROVENANCE_LABELS,
  STATUS_LABELS,
} from '../../shared/labels.ts';
import { confidence } from '../../shared/scheduler.ts';
import type { EffectiveGrade, ErrorType, Grade, Importance, Provenance, QuestionKind, QuestionStatus } from '../../shared/types.ts';
import { getSettings, today } from './settings.ts';
import { progress } from './stats.ts';

function sheet(wb: ExcelJS.Workbook, name: string, columns: { header: string; key: string; width: number }[]): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  ws.columns = columns;
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE8DF' } };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

const gradeLabel = (g: unknown) => (g === 'void' ? 'לא נספר' : g ? GRADE_LABELS[g as Grade] : '');

export async function buildWorkbook(): Promise<Buffer> {
  const settings = getSettings();
  const d = today();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'מערכת זיכרון ארוך טווח';
  wb.created = new Date();

  const units = sheet(wb, 'יחידות ידע', [
    { header: 'קורס', key: 'course', width: 22 },
    { header: 'נושא', key: 'topic', width: 26 },
    { header: 'יחידה', key: 'title', width: 36 },
    { header: 'נלמד ב', key: 'learned', width: 12 },
    { header: 'חזרה הבאה', key: 'due', width: 12 },
    { header: 'מרווח (ימים)', key: 'interval', width: 12 },
    { header: 'ביטחון', key: 'confidence', width: 10 },
    { header: 'חזרות', key: 'reps', width: 8 },
    { header: 'כישלונות', key: 'lapses', width: 9 },
    { header: 'מצב תיקון', key: 'remediation', width: 10 },
    { header: 'חשיבות', key: 'importance', width: 10 },
    { header: 'מצב', key: 'status', width: 10 },
    { header: 'סיבת התזמון', key: 'reason', width: 60 },
  ]);
  for (const r of all<Row>(
    `SELECT u.*, t.name AS topic, t.importance AS t_imp, c.name AS course FROM units u
     JOIN topics t ON t.id = u.topic_id JOIN courses c ON c.id = t.course_id
     WHERE u.status IN ('active','suspended') ORDER BY c.name, t.name, u.title`,
  )) {
    const step = Number(r.step);
    const reason = r.schedule_reason ? (JSON.parse(String(r.schedule_reason)) as { lines: string[] }).lines.join(' ') : '';
    units.addRow({
      course: r.course,
      topic: r.topic,
      title: r.title,
      learned: r.learned_on,
      due: r.due_date,
      interval: step >= 0 ? settings.ladder[Math.min(step, settings.ladder.length - 1)] : '',
      confidence: CONFIDENCE_LABELS[
        confidence({
          reps: Number(r.reps),
          remediation: Number(r.remediation) === 1,
          lastGrade: r.last_grade as EffectiveGrade | null,
          cleanStreak: Number(r.clean_streak),
          step,
        })
      ],
      reps: Number(r.reps),
      lapses: Number(r.lapses),
      remediation: Number(r.remediation) === 1 ? 'כן' : '',
      importance: IMPORTANCE_LABELS[((r.importance as Importance | null) ?? (r.t_imp as Importance)) || 'normal'],
      status: r.status === 'active' ? 'פעילה' : 'מושהית',
      reason,
    });
  }

  const qs = sheet(wb, 'שאלות', [
    { header: 'יחידה', key: 'unit', width: 30 },
    { header: 'סוג', key: 'kind', width: 14 },
    { header: 'שאלה', key: 'prompt', width: 50 },
    { header: 'תשובה', key: 'answer', width: 60 },
    { header: 'מצב', key: 'status', width: 14 },
    { header: 'מקור התשובה', key: 'prov', width: 18 },
    { header: 'מקורות', key: 'sources', width: 40 },
  ]);
  for (const r of all<Row>(
    `SELECT q.*, u.title AS unit,
       (SELECT GROUP_CONCAT(s.title || COALESCE(' · ' || COALESCE(l.locator, c.locator_label), ''), ' | ')
        FROM source_links l JOIN sources s ON s.id = l.source_id LEFT JOIN source_chunks c ON c.id = l.chunk_id
        WHERE l.entity_type = 'question' AND l.entity_id = q.id AND l.role = 'supports') AS sources
     FROM questions q JOIN units u ON u.id = q.unit_id WHERE q.status != 'rejected' ORDER BY u.title, q.id`,
  )) {
    qs.addRow({
      unit: r.unit,
      kind: KIND_LABELS[r.kind as QuestionKind],
      prompt: r.prompt,
      answer: r.answer,
      status: STATUS_LABELS[r.status as QuestionStatus],
      prov: PROVENANCE_LABELS[r.provenance as Provenance],
      sources: r.sources ?? '',
    });
  }

  const rev = sheet(wb, 'היסטוריית חזרות', [
    { header: 'תאריך', key: 'date', width: 12 },
    { header: 'יחידה', key: 'unit', width: 32 },
    { header: 'שאלה', key: 'prompt', width: 40 },
    { header: 'דירוג', key: 'grade', width: 10 },
    { header: 'נספר כ', key: 'eff', width: 10 },
    { header: 'רמז', key: 'hint', width: 6 },
    { header: 'תיקון', key: 'corr', width: 6 },
    { header: 'סוג טעות', key: 'err', width: 16 },
    { header: 'שניות', key: 'secs', width: 8 },
    { header: 'ימים מהחזרה הקודמת', key: 'gap', width: 12 },
    { header: 'החזרה הבאה', key: 'next', width: 12 },
    { header: 'הסבר', key: 'why', width: 60 },
  ]);
  for (const r of all<Row>(
    `SELECT r.*, u.title AS unit, q.prompt FROM reviews r JOIN units u ON u.id = r.unit_id LEFT JOIN questions q ON q.id = r.question_id
     ORDER BY r.reviewed_at DESC`,
  )) {
    rev.addRow({
      date: r.local_date,
      unit: r.unit,
      prompt: r.prompt ?? '',
      grade: gradeLabel(r.grade),
      eff: gradeLabel(r.effective_grade),
      hint: Number(r.hint_used) ? 'כן' : '',
      corr: Number(r.is_correction) ? 'כן' : '',
      err: r.error_type ? ERROR_LABELS[r.error_type as ErrorType] : '',
      secs: r.total_ms ? Math.round(Number(r.total_ms) / 1000) : '',
      gap: r.gap_days,
      next: r.new_due ?? '',
      why: r.schedule_reason ? (JSON.parse(String(r.schedule_reason)) as { lines: string[] }).lines.join(' ') : '',
    });
  }

  const cal = sheet(wb, 'לוח חזרות', [
    { header: 'תאריך', key: 'date', width: 12 },
    { header: 'חזרות מתוכננות', key: 'n', width: 16 },
    { header: 'יחידות', key: 'units', width: 90 },
  ]);
  const byDate = new Map<string, string[]>();
  for (const r of all<Row>(
    `SELECT u.title, u.due_date FROM units u JOIN topics t ON t.id = u.topic_id JOIN courses c ON c.id = t.course_id
     WHERE u.status = 'active' AND c.archived = 0 AND u.due_date <= ? ORDER BY u.due_date`,
    addDays(d, 120),
  )) {
    const key = String(r.due_date) < d ? d : String(r.due_date);
    byDate.set(key, [...(byDate.get(key) ?? []), String(r.title)]);
  }
  for (const [date, list] of [...byDate].sort()) cal.addRow({ date, n: list.length, units: list.join(' · ') });

  const p = progress();
  const sum = sheet(wb, 'סיכום', [
    { header: 'מדד', key: 'k', width: 40 },
    { header: 'ערך', key: 'v', width: 20 },
  ]);
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  sum.addRows([
    { k: 'תאריך הדוח', v: d },
    { k: 'יחידות פעילות', v: p.totals.units },
    { k: 'חזרות שבוצעו (סה״כ)', v: p.totals.reviews },
    { k: 'שיעור ביצוע חזרות (30 יום)', v: pct(p.completion.rate) },
    { k: 'זכירה אחרי שבוע ומעלה', v: `${pct(p.retentionWeek.rate)} (${p.retentionWeek.total})` },
    { k: 'זכירה אחרי חודש ומעלה', v: `${pct(p.retentionMonth.rate)} (${p.retentionMonth.total})` },
    { k: 'דקות ביום לימוד (ממוצע, 30 יום)', v: p.minutesPerActiveDay },
    { k: 'חזרות שנדחו (30 יום)', v: p.deferred30 },
    { k: 'שיעור שימוש ברמזים', v: pct(p.hintRate) },
    { k: 'שאלות שממתינות לאישור', v: p.quality.pending },
    { k: 'שאלות מסומנות לבדיקה', v: p.quality.flagged },
    { k: 'סתירות פתוחות', v: p.quality.openConflicts },
    { k: 'יחידות ללא מקור מתועד', v: p.quality.unitsWithoutSource },
  ]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
