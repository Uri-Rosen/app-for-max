// The approval screen: what approving a source means, and a last look at
// what is being approved.

import { Modal } from '../../ui.tsx';
import type { SourceDTO } from '../../../../shared/api.ts';
import { SOURCE_KIND_LABELS, SOURCE_KIND_ROLE } from '../../../../shared/labels.ts';
import type { SourceKind } from '../../../../shared/types.ts';
import { count, extentLabel } from './common.tsx';

export default function ApproveModal(props: {
  source: SourceDTO;
  kind: SourceKind;
  courseName: string;
  dirty: boolean;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const s = props.source;
  const extent = extentLabel(s.fileExt, s.pageCount);
  return (
    <Modal
      title="אישור מקור"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn primary" onClick={props.onConfirm} disabled={props.busy} autoFocus>
            {props.busy ? 'מאשר…' : props.dirty ? 'שמור ואשר' : 'אשר מקור'}
          </button>
          <button className="btn" onClick={props.onClose} disabled={props.busy}>
            עוד לא
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="callout info">
          <strong>אישור אומר: הטקסט שחולץ נכון, והמקור הזה מותר לשימוש כבסיס לשאלות.</strong>
          <div className="small" style={{ marginTop: 4 }}>
            האישור לא מכניס שום דבר ללוח החזרות. אחריו אפשר לבקש מה־AI הצעות לנושאים וליחידות — וגם הן מחכות לאישור שלך במסך בדיקה ואישור.
          </div>
        </div>

        <dl className="fields">
          <dt>מקור</dt>
          <dd dir="auto">{s.title}</dd>
          <dt>קורס</dt>
          <dd>{props.courseName}</dd>
          <dt>סוג</dt>
          <dd>
            {SOURCE_KIND_LABELS[props.kind]} <span className="muted small">— {SOURCE_KIND_ROLE[props.kind]}</span>
          </dd>
          <dt>טקסט</dt>
          <dd>
            {count(s.chunkCount, 'קטע אחד', 'קטעים')}
            {extent ? ` מתוך ${extent}` : ''}
          </dd>
        </dl>

        {props.kind === 'student_summary' && (
          <div className="callout warn small">
            זה סיכום של סטודנטים: הוא עזר שימושי, אבל כל שאלה שתיווצר ממנו צריכה להיבדק מול חומרי הקורס לפני שמאשרים אותה.
          </div>
        )}
        {props.kind === 'past_exam' && (
          <div className="callout warn small">מבחן קודם הוא דוגמה לסגנון ולדגשים — לא מקור סמכותי יחיד לתשובה.</div>
        )}
        {props.kind === 'syllabus' && (
          <div className="callout small">סילבוס הוא מפת ציפיות: נושאים שיוצעו ממנו יסומנו כהצעה, והמבנה הסופי ייקבע לפי מה שנלמד בפועל.</div>
        )}
        {s.warnings.length > 0 && (
          <div className="callout warn small">
            יש {count(s.warnings.length, 'אזהרה אחת', 'אזהרות')} מהחילוץ (למשל עמודים בלי שכבת טקסט). אשר רק אם מה שחסר לא חשוב — אחרת עדיף להוסיף
            את החומר החסר כמקור נפרד.
          </div>
        )}
        {s.duplicateOf !== null && <div className="callout warn small">הקובץ כולו זהה למקור #{s.duplicateOf}. אין צורך לאשר את שניהם.</div>}
        {s.dupChunkCount > 0 && (
          <div className="callout small">{count(s.dupChunkCount, 'קטע אחד זהה', 'קטעים זהים')} לקטעים במקורות אחרים — זה בסדר, רק כדאי לדעת.</div>
        )}
        {props.dirty && <div className="callout warn small">יש שינויים שלא נשמרו בפרטי המקור. הם יישמרו לפני האישור.</div>}
      </div>
    </Modal>
  );
}
