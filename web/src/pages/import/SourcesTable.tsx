// The list of every source, as a table on wide screens and a compact list on
// phones. Each row opens the source page.

import { Link, go } from '../../router.tsx';
import { CourseChip } from '../../ui.tsx';
import type { CourseDTO, SourceDTO } from '../../../../shared/api.ts';
import { SOURCE_KIND_LABELS } from '../../../../shared/labels.ts';
import { ORIGIN_LABELS, SourceStatusBadge, count, extLabel, extentLabel, formatIsoDay, useMedia } from './common.tsx';

function CourseCell({ s, courses }: { s: SourceDTO; courses: Map<number, CourseDTO> }) {
  if (s.courseId === null) return <span className="badge warn">ללא קורס</span>;
  const c = courses.get(s.courseId);
  return c ? <CourseChip name={c.name} color={c.color} /> : <span className="muted">קורס #{s.courseId}</span>;
}

function Problem({ s }: { s: SourceDTO }) {
  if (s.status === 'error' && s.extractError) {
    return (
      <div className="small" style={{ color: 'var(--wrong)' }}>
        {s.extractError}
      </div>
    );
  }
  if (s.status === 'missing') {
    return (
      <div className="tiny" style={{ color: 'var(--wrong)' }}>
        הקובץ לא נמצא{s.filePath ? ':' : ''} {s.filePath && <span className="ltr">{s.filePath}</span>}
      </div>
    );
  }
  return null;
}

function Warnings({ s }: { s: SourceDTO }) {
  if (s.warnings.length === 0) return <span className="muted">—</span>;
  return (
    <span className="badge warn" title={s.warnings.join('\n')}>
      {s.warnings.length}
    </span>
  );
}

function Dups({ s }: { s: SourceDTO }) {
  if (s.duplicateOf === null && s.dupChunkCount === 0) return <span className="muted">—</span>;
  return (
    <span className="row" style={{ gap: 4 }}>
      {s.duplicateOf !== null && (
        <span className="badge warn" title="הקובץ כולו זהה למקור אחר">
          זהה ל־#{s.duplicateOf}
        </span>
      )}
      {s.dupChunkCount > 0 && (
        <span className="badge partial" title="קטעים שהטקסט שלהם זהה לקטעים במקורות אחרים">
          {s.dupChunkCount}
        </span>
      )}
    </span>
  );
}

export default function SourcesTable({ sources, courses }: { sources: SourceDTO[]; courses: Map<number, CourseDTO> }) {
  const narrow = useMedia('(max-width: 760px)');

  if (narrow) {
    return (
      <div className="list">
        {sources.map((s) => (
          <div key={s.id} className="list-item" style={{ alignItems: 'flex-start' }}>
            <div className="grow stack" style={{ gap: 4 }}>
              <Link to={`/import/source/${s.id}`}>
                <span dir="auto" style={{ fontWeight: 600 }}>
                  {s.title}
                </span>
              </Link>
              <div className="row" style={{ gap: 6 }}>
                <SourceStatusBadge s={s.status} />
                <span className="badge outline">{SOURCE_KIND_LABELS[s.kind]}</span>
                <CourseCell s={s} courses={courses} />
              </div>
              <div className="tiny muted">
                {[
                  s.chunkCount > 0 ? count(s.chunkCount, 'קטע אחד', 'קטעים') : null,
                  extentLabel(s.fileExt, s.pageCount),
                  s.dupChunkCount > 0 ? `${s.dupChunkCount} כפולים` : null,
                  s.duplicateOf !== null ? `זהה ל־#${s.duplicateOf}` : null,
                  s.warnings.length > 0 ? count(s.warnings.length, 'אזהרה אחת', 'אזהרות') : null,
                  `נוסף ${formatIsoDay(s.addedAt)}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              <Problem s={s} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>כותרת</th>
            <th>קורס</th>
            <th>סוג</th>
            <th>מצב</th>
            <th title="עמודים, שקופיות או גיליונות בקובץ / קטעי טקסט שחולצו">עמודים / קטעים</th>
            <th title="קטעים שהטקסט שלהם זהה למקור אחר">כפילויות</th>
            <th>אזהרות</th>
            <th>נוסף</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => (
            <tr
              key={s.id}
              className="clickable"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('a, button')) return;
                go(`/import/source/${s.id}`);
              }}
            >
              <td style={{ minWidth: 220 }}>
                <Link to={`/import/source/${s.id}`}>
                  <span dir="auto" style={{ fontWeight: 600 }}>
                    {s.title}
                  </span>
                </Link>
                <div className="tiny muted">
                  {ORIGIN_LABELS[s.origin]}
                  {s.fileExt ? ` · ${extLabel(s.fileExt)}` : ''}
                  {s.url && !s.fileExt ? ' · קישור' : ''}
                </div>
                <Problem s={s} />
              </td>
              <td>
                <CourseCell s={s} courses={courses} />
              </td>
              <td className="nowrap">{SOURCE_KIND_LABELS[s.kind]}</td>
              <td>
                <SourceStatusBadge s={s.status} />
              </td>
              <td className="num nowrap">
                {s.pageCount ?? '—'} / {s.chunkCount || '—'}
              </td>
              <td>
                <Dups s={s} />
              </td>
              <td>
                <Warnings s={s} />
              </td>
              <td className="nowrap muted">{formatIsoDay(s.addedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
