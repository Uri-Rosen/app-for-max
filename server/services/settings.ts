import { record } from '../audit.ts';
import { all } from '../db/index.ts';
import { studyDate } from '../../shared/dates.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/types.ts';

import { now } from '../clock.ts';

export { clockOffset, now, setClockOffsetDays } from '../clock.ts';

export function getSettings(): Settings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
    if (r.key in DEFAULT_SETTINGS) {
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        // keep default
      }
    }
  }
  return out as unknown as Settings;
}

export function today(): string {
  return studyDate(now(), getSettings().dayStartHour);
}

function positiveInt(v: unknown, min: number, max: number, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}: צריך מספר שלם בין ${min} ל־${max}`);
  return n;
}

export function validateSettings(patch: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {};
  if (patch.budgetMinutes !== undefined) out.budgetMinutes = positiveInt(patch.budgetMinutes, 1, 240, 'זמן יומי');
  if (patch.maxItems !== undefined) out.maxItems = positiveInt(patch.maxItems, 1, 500, 'מספר שאלות');
  if (patch.ladder !== undefined) {
    const l = patch.ladder;
    if (!Array.isArray(l) || l.length < 2 || l.length > 20) throw new Error('לוח המרווחים צריך 2–20 שלבים');
    const nums = l.map((x) => positiveInt(x, 1, 3650, 'מרווח'));
    for (let i = 1; i < nums.length; i++) if (nums[i] < nums[i - 1]) throw new Error('המרווחים צריכים להיות בסדר עולה');
    out.ladder = nums;
  }
  if (patch.remediationCapDays !== undefined) out.remediationCapDays = positiveInt(patch.remediationCapDays, 1, 365, 'תקרת תיקון');
  if (patch.remediationWindow !== undefined) out.remediationWindow = positiveInt(patch.remediationWindow, 2, 20, 'חלון תיקון');
  if (patch.remediationLapses !== undefined) out.remediationLapses = positiveInt(patch.remediationLapses, 1, 20, 'כישלונות לתיקון');
  if (patch.remediationClearStreak !== undefined)
    out.remediationClearStreak = positiveInt(patch.remediationClearStreak, 1, 20, 'הצלחות ליציאה מתיקון');
  if (patch.defaultAnswerSeconds !== undefined)
    out.defaultAnswerSeconds = positiveInt(patch.defaultAnswerSeconds, 5, 1800, 'זמן ברירת מחדל לשאלה');
  if (patch.dayStartHour !== undefined) out.dayStartHour = positiveInt(patch.dayStartHour, 0, 12, 'שעת תחילת יום');
  if (patch.examWindowDays !== undefined) out.examWindowDays = positiveInt(patch.examWindowDays, 0, 120, 'חלון מבחן');
  if (patch.longGapDays !== undefined) out.longGapDays = positiveInt(patch.longGapDays, 1, 3650, 'פער ארוך');
  if (patch.autoBackupKeep !== undefined) out.autoBackupKeep = positiveInt(patch.autoBackupKeep, 3, 3650, 'גיבויים לשמירה');
  if (patch.aiProvider !== undefined) {
    if (patch.aiProvider !== 'mock' && patch.aiProvider !== 'ollama') throw new Error('ספק AI לא מוכר');
    out.aiProvider = patch.aiProvider;
  }
  if (patch.ollamaUrl !== undefined) {
    const u = String(patch.ollamaUrl);
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(u))
      throw new Error('כתובת Ollama חייבת להיות מקומית (127.0.0.1 או localhost)');
    out.ollamaUrl = u.replace(/\/$/, '');
  }
  if (patch.ollamaModel !== undefined) out.ollamaModel = String(patch.ollamaModel).trim().slice(0, 100);
  return out;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const clean = validateSettings(patch);
  record({ action: 'settings.update', summary: `עדכון הגדרות: ${Object.keys(clean).join(', ')}` }, (cs) => {
    for (const [key, value] of Object.entries(clean)) cs.upsert('settings', { key, value: JSON.stringify(value) });
  });
  return getSettings();
}
