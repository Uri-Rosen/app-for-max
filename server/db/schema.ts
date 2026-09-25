// Schema migrations. Append only: a shipped migration is never edited, so a
// database restored from an old backup upgrades the same way a live one did.

import type { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE courses (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT,
    term TEXT,
    exam_date TEXT,
    color TEXT,
    watch_folder TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE topics (
    id INTEGER PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id),
    parent_id INTEGER REFERENCES topics(id),
    name TEXT NOT NULL,
    description TEXT,
    importance TEXT NOT NULL DEFAULT 'normal',
    foundational INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    merged_into_id INTEGER REFERENCES topics(id),
    syllabus_order INTEGER,
    created_by TEXT NOT NULL DEFAULT 'user',
    ai_run_id INTEGER,
    validation TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX topics_course ON topics(course_id, status);

  CREATE TABLE topic_aliases (
    id INTEGER PRIMARY KEY,
    topic_id INTEGER NOT NULL REFERENCES topics(id),
    alias TEXT NOT NULL,
    from_topic_id INTEGER REFERENCES topics(id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE lessons (
    id INTEGER PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id),
    title TEXT NOT NULL,
    studied_on TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'lecture',
    notes TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE lesson_topics (
    id INTEGER PRIMARY KEY,
    lesson_id INTEGER NOT NULL REFERENCES lessons(id),
    topic_id INTEGER NOT NULL REFERENCES topics(id),
    UNIQUE (lesson_id, topic_id)
  );

  CREATE TABLE lesson_sources (
    id INTEGER PRIMARY KEY,
    lesson_id INTEGER NOT NULL REFERENCES lessons(id),
    source_id INTEGER NOT NULL REFERENCES sources(id),
    UNIQUE (lesson_id, source_id)
  );

  CREATE TABLE units (
    id INTEGER PRIMARY KEY,
    topic_id INTEGER NOT NULL REFERENCES topics(id),
    original_topic_id INTEGER REFERENCES topics(id),
    lesson_id INTEGER REFERENCES lessons(id),
    title TEXT NOT NULL,
    content TEXT,
    learned_on TEXT NOT NULL,
    importance TEXT,
    foundational INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_by TEXT NOT NULL DEFAULT 'user',
    ai_run_id INTEGER,
    validation TEXT,
    created_at TEXT NOT NULL,
    -- scheduling state; written only by the scheduler
    step INTEGER NOT NULL DEFAULT -1,
    due_date TEXT,
    last_reviewed_on TEXT,
    last_grade TEXT,
    last_question_id INTEGER,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    clean_streak INTEGER NOT NULL DEFAULT 0,
    remediation INTEGER NOT NULL DEFAULT 0,
    recent_grades TEXT NOT NULL DEFAULT '[]',
    schedule_reason TEXT
  );
  CREATE INDEX units_due ON units(status, due_date);
  CREATE INDEX units_topic ON units(topic_id);

  CREATE TABLE questions (
    id INTEGER PRIMARY KEY,
    unit_id INTEGER NOT NULL REFERENCES units(id),
    kind TEXT NOT NULL,
    prompt TEXT NOT NULL,
    answer TEXT NOT NULL,
    explanation TEXT,
    hint TEXT,
    key_points TEXT NOT NULL DEFAULT '[]',
    structure TEXT,
    related_unit_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'approved',
    provenance TEXT NOT NULL DEFAULT 'unverified',
    created_by TEXT NOT NULL DEFAULT 'user',
    verified_at TEXT,
    flag_reason TEXT,
    ai_run_id INTEGER,
    validation TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX questions_unit ON questions(unit_id, status);

  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    course_id INTEGER REFERENCES courses(id),
    kind TEXT NOT NULL DEFAULT 'course_material',
    title TEXT NOT NULL,
    origin TEXT NOT NULL,
    file_path TEXT,
    url TEXT,
    file_hash TEXT,
    file_size INTEGER,
    file_mtime TEXT,
    file_ext TEXT,
    studied_on TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    extract_error TEXT,
    warnings TEXT NOT NULL DEFAULT '[]',
    page_count INTEGER,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    dup_chunk_count INTEGER NOT NULL DEFAULT 0,
    duplicate_of INTEGER REFERENCES sources(id),
    previous_version_id INTEGER REFERENCES sources(id),
    outline TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    added_at TEXT NOT NULL,
    extracted_at TEXT,
    approved_at TEXT
  );
  CREATE INDEX sources_hash ON sources(file_hash);
  CREATE INDEX sources_path ON sources(file_path);

  CREATE TABLE source_chunks (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    seq INTEGER NOT NULL,
    locator_type TEXT NOT NULL,
    locator_num INTEGER NOT NULL,
    locator_label TEXT NOT NULL,
    heading TEXT,
    text TEXT NOT NULL,
    notes TEXT,
    norm_hash TEXT NOT NULL,
    duplicate_of_chunk_id INTEGER REFERENCES source_chunks(id)
  );
  CREATE INDEX chunks_source ON source_chunks(source_id, seq);
  CREATE INDEX chunks_hash ON source_chunks(norm_hash);

  CREATE VIRTUAL TABLE chunk_fts USING fts5(heading, text, content='source_chunks', content_rowid='id');
  CREATE TRIGGER chunks_ai AFTER INSERT ON source_chunks BEGIN
    INSERT INTO chunk_fts(rowid, heading, text) VALUES (new.id, new.heading, new.text);
  END;
  CREATE TRIGGER chunks_ad AFTER DELETE ON source_chunks BEGIN
    INSERT INTO chunk_fts(chunk_fts, rowid, heading, text) VALUES ('delete', old.id, old.heading, old.text);
  END;

  CREATE TABLE source_links (
    id INTEGER PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    chunk_id INTEGER REFERENCES source_chunks(id),
    locator TEXT,
    quote TEXT,
    role TEXT NOT NULL DEFAULT 'supports',
    resolved INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX links_entity ON source_links(entity_type, entity_id);

  CREATE TABLE reviews (
    id INTEGER PRIMARY KEY,
    unit_id INTEGER NOT NULL REFERENCES units(id),
    question_id INTEGER REFERENCES questions(id),
    local_date TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    grade TEXT NOT NULL,
    effective_grade TEXT NOT NULL,
    hint_used INTEGER NOT NULL DEFAULT 0,
    is_correction INTEGER NOT NULL DEFAULT 0,
    user_answer TEXT,
    answer_ms INTEGER,
    total_ms INTEGER,
    error_type TEXT,
    confused_with TEXT,
    missing_points TEXT NOT NULL DEFAULT '[]',
    note TEXT,
    prev_step INTEGER,
    new_step INTEGER,
    prev_due TEXT,
    new_due TEXT,
    interval_days INTEGER,
    gap_days INTEGER,
    appeared_because TEXT,
    schedule_reason TEXT
  );
  CREATE INDEX reviews_date ON reviews(local_date);
  CREATE INDEX reviews_unit ON reviews(unit_id, reviewed_at);

  CREATE TABLE day_log (
    local_date TEXT PRIMARY KEY,
    due_unit_ids TEXT NOT NULL DEFAULT '[]',
    first_seen_at TEXT NOT NULL,
    budget_minutes INTEGER NOT NULL
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    changes TEXT NOT NULL,
    undoable INTEGER NOT NULL DEFAULT 1,
    undone_at TEXT,
    undo_of INTEGER REFERENCES audit_log(id)
  );

  CREATE TABLE ai_runs (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT,
    task TEXT NOT NULL,
    source_id INTEGER REFERENCES sources(id),
    course_id INTEGER REFERENCES courses(id),
    chunk_ids TEXT NOT NULL DEFAULT '[]',
    output TEXT,
    error TEXT,
    stats TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
  );
  `,
  /* 2 */ `
  -- Remembers what a folder source was before its file went missing, so it
  -- returns to the same state (usually approved) when the file comes back.
  ALTER TABLE sources ADD COLUMN status_before_missing TEXT;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db: DatabaseSync): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (current > MIGRATIONS.length) {
    throw new Error(`מסד הנתונים נוצר בגרסה חדשה יותר (${current}) של המערכת. עדכן את המערכת לפני הפתיחה.`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
