import { describe, expect, it } from 'vitest';
import {
  MockProvider,
  OllamaProvider,
  chunkMap,
  getProvider,
  validateConflict,
  validateQuestion,
  validateTopic,
  validateUnit,
} from '../server/ai/index.ts';
import type { ChunkRef, QuestionSuggestion, StyleExample, UnitSuggestion, UnitsInput } from '../server/ai/types.ts';
import { TEMPLATE_FIELDS } from '../shared/types.ts';

// ---------- fixtures ----------

const signaling: ChunkRef = {
  chunkId: 1,
  sourceId: 1,
  sourceTitle: 'שיעור 3 — איתות תאי',
  sourceKind: 'slides',
  locatorLabel: 'שקופית 2',
  heading: 'איתות תאי',
  text: [
    'איתות תאי',
    'אינסולין – הורמון שמופרש מתאי בטא בלבלב ומוריד את רמת הסוכר בדם',
    'גלוקגון – הורמון שמופרש מתאי אלפא בלבלב ומעלה את רמת הסוכר בדם',
    'קולטן הוא חלבון שנקשר למולקולת אות ומעביר את האות לתוך התא.',
    'אינסולין → קולטן אינסולין → GLUT4 → קליטת גלוקוז',
    'אינסולין מגביר את קליטת הגלוקוז לתאי השריר והשומן.',
    'חוסר באינסולין גורם לעלייה ברמת הסוכר בדם.',
  ].join('\n'),
};

const membranes: ChunkRef = {
  chunkId: 2,
  sourceId: 1,
  sourceTitle: 'שיעור 3 — איתות תאי',
  sourceKind: 'slides',
  locatorLabel: 'שקופית 3',
  heading: 'תעבורה דרך הממברנה',
  text: [
    '• תעבורה סבילה – מעבר חומרים דרך הממברנה במורד מפל הריכוזים, ללא השקעת אנרגיה',
    '• תעבורה פעילה – מעבר חומרים נגד מפל הריכוזים, תוך השקעת ATP',
    'התהליך שבו מים עוברים דרך ממברנה בררנית נקרא אוסמוזה.',
  ].join('\n'),
};

const syllabus: ChunkRef = {
  chunkId: 3,
  sourceId: 2,
  sourceTitle: 'סילבוס ביולוגיה של התא',
  sourceKind: 'syllabus',
  locatorLabel: "עמ' 1",
  heading: 'סילבוס',
  text: [
    'סילבוס – ביולוגיה של התא',
    'שבוע 1: מבוא לתא',
    'שבוע 2: ממברנות – מבנה ותעבורה',
    '- תעבורה סבילה',
    '- תעבורה פעילה',
    'שבוע 3: איתות תאי',
    'שבוע 4 (12.11): חופשת סוכות',
    'דרישות הקורס:',
    '1. נוכחות חובה',
    '2. מבחן מסכם 80%',
  ].join('\n'),
};

const studentSummary: ChunkRef = {
  chunkId: 4,
  sourceId: 3,
  sourceTitle: 'סיכום של דנה',
  sourceKind: 'student_summary',
  locatorLabel: "עמ' 2",
  heading: 'הורמונים',
  text: 'אינסולין – הורמון שמעלה את רמת הסוכר בדם',
};

const enzymes: ChunkRef = {
  chunkId: 5,
  sourceId: 4,
  sourceTitle: 'Lecture 5 — Enzymes',
  sourceKind: 'course_material',
  locatorLabel: 'p. 3',
  heading: 'Enzymes',
  text: [
    'Enzymes are proteins that speed up chemical reactions by lowering the activation energy.',
    'A kinase is an enzyme that transfers phosphate groups to proteins.',
    'A phosphatase is an enzyme that removes phosphate groups from proteins.',
    'Phosphorylation activates glycogen phosphorylase.',
    'Ligand -> receptor -> G protein -> adenylyl cyclase -> cAMP -> cellular response',
    'It is important to note that the receptor is found in the membrane.',
  ].join('\n'),
};

const numberedSyllabus: ChunkRef = {
  chunkId: 6,
  sourceId: 5,
  sourceTitle: 'Syllabus',
  sourceKind: 'syllabus',
  locatorLabel: 'p. 1',
  heading: 'Course schedule',
  text: ['1. Cell structure', '2) Membrane transport', '3. Cell signaling', 'Grading:', '1. Final exam 70%'].join('\n'),
};

const junkSlides: ChunkRef = {
  chunkId: 7,
  sourceId: 1,
  sourceTitle: 'שיעור 3 — איתות תאי',
  sourceKind: 'slides',
  locatorLabel: 'שקופית 9',
  heading: 'שאלות?',
  text: 'תודה',
};

const pastExam: ChunkRef = {
  chunkId: 8,
  sourceId: 6,
  sourceTitle: 'מבחן 2023 מועד א',
  sourceKind: 'past_exam',
  locatorLabel: "עמ' 1",
  heading: null,
  text: '1. מהו תפקידו של האינסולין?\nPCR – שיטה להגברת מקטעי DNA במבחנה',
};

const allChunks = [signaling, membranes, syllabus, studentSummary, enzymes, numberedSyllabus, junkSlides, pastExam];
const chunks = chunkMap(allChunks);

function unitsInput(over: Partial<UnitsInput> = {}): UnitsInput {
  return { course: 'ביולוגיה של התא', topicHint: null, chunks: allChunks, existingTopics: ['איתות תאי'], style: [], ...over };
}

const mock = new MockProvider();

function allQuestions(units: UnitSuggestion[]): QuestionSuggestion[] {
  return units.flatMap((u) => u.questions);
}

function unit(units: UnitSuggestion[], title: string): UnitSuggestion {
  const u = units.find((x) => x.title === title);
  if (!u) throw new Error(`no unit "${title}" in: ${units.map((x) => x.title).join(', ')}`);
  return u;
}

function codes(r: { checks: { code: string; ok: boolean }[] }): string[] {
  return r.checks.filter((c) => !c.ok).map((c) => c.code);
}

// ---------- mock: topics ----------

describe('MockProvider.suggestTopics', () => {
  it('reads headings and syllabus week lines, with syllabus order and parents', async () => {
    const topics = await mock.suggestTopics({ course: 'ביולוגיה של התא', chunks: allChunks, existingTopics: [] });
    const byName = new Map(topics.map((t) => [t.name, t]));

    const signalingTopic = byName.get('איתות תאי');
    expect(signalingTopic?.syllabusOrder).toBe(3); // slide heading merged with "שבוע 3: איתות תאי"
    expect(signalingTopic?.evidence.map((e) => e.chunkId).sort()).toEqual([1, 3]);
    expect(byName.get('מבוא לתא')?.syllabusOrder).toBe(1);
    expect(byName.get('ממברנות')).toMatchObject({ syllabusOrder: 2, description: 'מבנה ותעבורה' });
    expect(byName.get('תעבורה סבילה')).toMatchObject({ parentName: 'ממברנות', syllabusOrder: null });
    expect(byName.get('תעבורה דרך הממברנה')?.syllabusOrder).toBeNull();

    // Numbered list in an English syllabus: order from the number; the grading list is skipped.
    expect(byName.get('Cell structure')?.syllabusOrder).toBe(1);
    expect(byName.get('Membrane transport')?.syllabusOrder).toBe(2);
    expect(byName.get('Cell signaling')?.syllabusOrder).toBe(3);

    const names = topics.map((t) => t.name);
    for (const junk of ['סילבוס', 'חופשת סוכות', 'נוכחות חובה', 'מבחן מסכם 80%', 'שאלות?', 'תודה', 'Course schedule', 'Final exam 70%']) {
      expect(names).not.toContain(junk);
    }
  });

  it('quotes the exact line and skips existing topics regardless of case, spacing and niqqud', async () => {
    const topics = await mock.suggestTopics({
      course: 'ביולוגיה של התא',
      chunks: allChunks,
      existingTopics: ['אִיתּוּת  תָּאִי', 'cell STRUCTURE'],
    });
    const names = topics.map((t) => t.name);
    expect(names).not.toContain('איתות תאי');
    expect(names).not.toContain('Cell structure');
    const intro = topics.find((t) => t.name === 'מבוא לתא');
    expect(intro?.evidence).toEqual([{ chunkId: 3, quote: 'שבוע 1: מבוא לתא' }]);
  });

  it('dedupes continuation slides ("(המשך)") into one topic', async () => {
    const a: ChunkRef = { ...signaling, chunkId: 20, heading: 'מיטוזה', text: 'שלבי המיטוזה' };
    const b: ChunkRef = { ...signaling, chunkId: 21, heading: 'מיטוזה (המשך)', text: 'ציטוקינזה' };
    const topics = await mock.suggestTopics({ course: 'x', chunks: [a, b], existingTopics: [] });
    expect(topics.map((t) => t.name)).toEqual(['מיטוזה']);
    expect(topics[0].evidence).toHaveLength(2);
  });
});

// ---------- mock: units ----------

describe('MockProvider.suggestUnits', () => {
  it('turns "term – definition" lines into a definition card and a cloze', async () => {
    const { units } = await mock.suggestUnits(unitsInput());
    const insulin = unit(units, 'אינסולין');
    expect(insulin.topicName).toBe('איתות תאי');
    const def = insulin.questions.find((q) => q.kind === 'definition');
    expect(def).toMatchObject({ prompt: 'מהו אינסולין?', answer: 'הורמון שמופרש מתאי בטא בלבלב ומוריד את רמת הסוכר בדם' });
    expect(def?.evidence[0]).toEqual({ chunkId: 1, quote: 'אינסולין – הורמון שמופרש מתאי בטא בלבלב ומוריד את רמת הסוכר בדם' });
    const cloze = insulin.questions.find((q) => q.kind === 'cloze');
    expect(cloze).toMatchObject({ prompt: '[[אינסולין]] – הורמון שמופרש מתאי בטא בלבלב ומוריד את רמת הסוכר בדם', answer: 'אינסולין' });

    // Copula and "נקרא" definitions, with grammatical question words.
    expect(unit(units, 'קולטן').questions[0].prompt).toBe('מהו קולטן?');
    expect(unit(units, 'תעבורה סבילה').questions[0].prompt).toBe('מהי תעבורה סבילה?');
    expect(unit(units, 'אוסמוזה').questions[0]).toMatchObject({ prompt: 'מהי אוסמוזה?', answer: 'התהליך שבו מים עוברים דרך ממברנה בררנית' });
  });

  it('writes causal questions with cause and effect as key points', async () => {
    const { units } = await mock.suggestUnits(unitsInput());
    const causal = allQuestions(units).filter((q) => q.kind === 'causal');
    const effect = causal.find((q) => q.prompt === 'מה ההשפעה של אינסולין על קליטת הגלוקוז לתאי השריר והשומן?');
    expect(effect?.answer).toBe('אינסולין מגביר את קליטת הגלוקוז לתאי השריר והשומן.');
    expect(effect?.keyPoints).toEqual(['סיבה: אינסולין', 'תוצאה: מגביר את קליטת הגלוקוז לתאי השריר והשומן']);
    // It joins the unit of its cause.
    expect(unit(units, 'אינסולין').questions).toContain(effect);

    const cause = causal.find((q) => q.prompt === 'מה גורם לעלייה ברמת הסוכר בדם?');
    expect(cause?.keyPoints).toEqual(['סיבה: חוסר באינסולין', 'תוצאה: עלייה ברמת הסוכר בדם']);

    const english = causal.find((q) => q.prompt === 'What is the effect of phosphorylation on glycogen phosphorylase?');
    expect(english?.keyPoints[0]).toBe('Cause: Phosphorylation');
  });

  it('compares two terms defined side by side', async () => {
    const { units } = await mock.suggestUnits(unitsInput());
    const comparisons = allQuestions(units).filter((q) => q.kind === 'comparison');
    const hormones = comparisons.find((q) => q.prompt === 'מה ההבדל בין אינסולין לגלוקגון?');
    expect(hormones?.keyPoints).toHaveLength(2);
    expect(hormones?.evidence.map((e) => e.chunkId)).toEqual([1, 1]);
    expect(comparisons.map((q) => q.prompt)).toContain('מה ההבדל בין תעבורה סבילה לתעבורה פעילה?');
    expect(comparisons.map((q) => q.prompt)).toContain('What is the difference between a kinase and a phosphatase?');
  });

  it('maps an arrow chain onto the pathway template, in order, with a cloze', async () => {
    const { units } = await mock.suggestUnits(unitsInput());
    const path = unit(units, 'מסלול: אינסולין → קליטת גלוקוז');
    const recall = path.questions.find((q) => q.kind === 'recall');
    expect(recall?.structure?.template).toBe('pathway');
    expect(Object.keys(recall?.structure?.fields ?? {})).toEqual([...TEMPLATE_FIELDS.pathway]);
    expect(recall?.structure?.fields).toEqual({ source: 'אינסולין', signal: 'קולטן אינסולין', target: 'GLUT4', outcome: 'קליטת גלוקוז' });
    expect(recall?.answer).toBe('אינסולין → קולטן אינסולין → GLUT4 → קליטת גלוקוז');
    const cloze = path.questions.find((q) => q.kind === 'cloze');
    expect(cloze?.prompt).toBe('השלם את המסלול: אינסולין → [[קולטן אינסולין]] → GLUT4 → קליטת גלוקוז');
    expect(cloze?.answer).toBe('קולטן אינסולין');

    // Six steps: the middle four merge into signal and target.
    const ligand = unit(units, 'Pathway: Ligand → cellular response').questions[0];
    expect(ligand.structure?.fields).toEqual({
      source: 'Ligand',
      signal: 'receptor → G protein',
      target: 'adenylyl cyclase → cAMP',
      outcome: 'cellular response',
    });
  });

  it('reads English definitions without mistaking predicates for them', async () => {
    const { units } = await mock.suggestUnits(unitsInput());
    expect(unit(units, 'Kinase').questions[0]).toMatchObject({ prompt: 'What is a kinase?', answer: 'An enzyme that transfers phosphate groups to proteins' });
    expect(unit(units, 'Enzymes').questions[0].prompt).toBe('What are enzymes?');
    expect(units.map((u) => u.title)).not.toContain('Receptor');
    expect(units.map((u) => u.title)).not.toContain('It');
  });

  it('never builds units from a syllabus', async () => {
    const { units } = await mock.suggestUnits(unitsInput({ chunks: [syllabus, numberedSyllabus] }));
    expect(units).toEqual([]);
  });

  it('imitates bare-term prompts from the learner\'s own cards', async () => {
    const style: StyleExample[] = [
      { kind: 'definition', prompt: 'מיטוכונדריה', answer: 'אברון שמייצר ATP בנשימה התאית' },
      { kind: 'definition', prompt: 'ריבוזום', answer: 'אברון שמתרגם mRNA לחלבון' },
      { kind: 'definition', prompt: 'מהו ליזוזום?', answer: 'אברון עם אנזימי פירוק' },
    ];
    const { units } = await mock.suggestUnits(unitsInput({ style }));
    expect(unit(units, 'אינסולין').questions.find((q) => q.kind === 'definition')?.prompt).toBe('אינסולין');
    expect(unit(units, 'Kinase').questions[0].prompt).toBe('Kinase');
    expect(unit(units, 'אינסולין').questions.find((q) => q.kind === 'definition')?.explanation).toBeNull();
  });

  it('puts extra context into the explanation when the learner writes long answers', async () => {
    const long = 'אברון בעל ממברנה כפולה שבו מתרחשת הנשימה התאית, ומייצר את רוב ה-ATP של התא; יש לו DNA משלו, והוא מתחלק באופן עצמאי מהתא. מקורו כנראה בחיידק שנבלע, לפי תאוריית האנדוסימביוזה.';
    const style: StyleExample[] = [
      { kind: 'definition', prompt: 'מהי מיטוכונדריה?', answer: long },
      { kind: 'definition', prompt: 'מהו ריבוזום?', answer: long },
    ];
    const { units } = await mock.suggestUnits(unitsInput({ style }));
    const def = unit(units, 'אינסולין').questions.find((q) => q.kind === 'definition');
    expect(def?.prompt).toBe('מהו אינסולין?');
    expect(def?.explanation).toContain('אינסולין מגביר את קליטת הגלוקוז');
    // The explanation is grounded too: its sentence is quoted as evidence.
    expect(def?.evidence.map((e) => e.quote)).toContain('אינסולין מגביר את קליטת הגלוקוז לתאי השריר והשומן.');
  });

  it('flags the same term defined differently by two sources, keeping the course-material version', async () => {
    const { units, conflicts } = await mock.suggestUnits(unitsInput());
    expect(conflicts).toHaveLength(1);
    const [c] = conflicts;
    expect(c.evidence.map((e) => e.chunkId)).toEqual([1, 4]);
    expect(c.description).toContain('אינסולין');
    expect(c.description).toContain('סיכום סטודנטים');
    expect(unit(units, 'אינסולין').evidence.map((e) => e.chunkId)).not.toContain(4);
  });

  it('reports low-overlap definitions as a conflict, and corroborates agreeing ones', async () => {
    const lesson: ChunkRef = { ...membranes, chunkId: 30, sourceId: 9, sourceKind: 'lesson_summary', text: 'אוסמוזה – תנועה של מים דרך ממברנה בררנית' };
    const other: ChunkRef = { ...membranes, chunkId: 31, sourceId: 10, sourceKind: 'course_material', text: 'קולטן – אתר קישור על גבי חלבון הממברנה' };
    const { units, conflicts } = await mock.suggestUnits(unitsInput({ chunks: [signaling, membranes, lesson, other] }));
    // "אוסמוזה" agrees with the slides → extra evidence, no conflict.
    expect(unit(units, 'אוסמוזה').evidence.map((e) => e.chunkId)).toEqual([2, 30]);
    // "קולטן" shares almost no words → conflict between two equally authoritative sources.
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].evidence.map((e) => e.chunkId)).toEqual([1, 31]);
  });

  it('marks method definitions with the method template and flags past-exam-only evidence', async () => {
    const { units } = await mock.suggestUnits(unitsInput({ chunks: [pastExam] }));
    const pcr = unit(units, 'PCR');
    const def = pcr.questions[0];
    expect(def.structure?.template).toBe('method');
    const report = validateQuestion(def, chunks);
    expect(report.ok).toBe(true);
    expect(codes(report)).toEqual(expect.arrayContaining(['warn.source.past_exam_only', 'warn.structure.missing']));
    // The exam question itself is not turned into a card.
    expect(allQuestions(units).some((q) => q.answer.includes('תפקידו'))).toBe(false);
  });

  it('is self-consistent: every suggestion passes validation', async () => {
    const topics = await mock.suggestTopics({ course: 'ביולוגיה של התא', chunks: allChunks, existingTopics: [] });
    expect(topics.length).toBeGreaterThan(5);
    for (const t of topics) expect(validateTopic(t, chunks), t.name).toMatchObject({ ok: true });

    for (const style of [[], [{ kind: 'definition' as const, prompt: 'ריבוזום', answer: 'אברון' }]]) {
      const out = await mock.suggestUnits(unitsInput({ style }));
      expect(out.units.length).toBeGreaterThan(8);
      for (const u of out.units) {
        const r = validateUnit(u, chunks);
        expect(r.ok, `${u.title}: ${codes(r).join(', ')}`).toBe(true);
        expect(codes(r).filter((c) => c.startsWith('warn.unit.'))).toEqual([]);
        for (const q of u.questions) {
          const qr = validateQuestion(q, chunks);
          expect(qr.ok, `${q.prompt}: ${codes(qr).join(', ')}`).toBe(true);
          expect(codes(qr), q.prompt).not.toContain('warn.answer.not_in_source');
          expect(codes(qr), q.prompt).not.toContain('warn.keypoints.missing');
          expect(codes(qr), q.prompt).not.toContain('warn.prompt.leaks_answer');
        }
      }
      for (const c of out.conflicts) expect(validateConflict(c, chunks).ok).toBe(true);
    }
  });

  it('is deterministic and caps the volume', async () => {
    expect(await mock.suggestUnits(unitsInput())).toEqual(await mock.suggestUnits(unitsInput()));
    const many: ChunkRef = {
      ...signaling,
      chunkId: 40,
      text: Array.from({ length: 60 }, (_, i) => `מונח${'אבגדהוזחטיכלמנסעפצקרשת'[i % 22]}${i} – הגדרה ארוכה מספיק של המונח מספר ${i}`).join('\n'),
    };
    const { units } = await mock.suggestUnits(unitsInput({ chunks: [many] }));
    expect(units.length).toBeLessThanOrEqual(40);
    expect(units.length).toBeGreaterThan(30);
  });

  it('is always available', async () => {
    expect((await mock.available()).ok).toBe(true);
    expect(mock.id).toBe('mock');
  });
});

// ---------- validation ----------

function q(over: Partial<QuestionSuggestion>): QuestionSuggestion {
  return {
    kind: 'definition',
    prompt: 'מהו אינסולין?',
    answer: 'הורמון שמופרש מתאי בטא בלבלב ומוריד את רמת הסוכר בדם',
    explanation: null,
    hint: null,
    keyPoints: [],
    structure: null,
    evidence: [{ chunkId: 1, quote: 'אינסולין – הורמון שמופרש מתאי בטא בלבלב ומוריד את רמת הסוכר בדם' }],
    ...over,
  };
}

describe('validation', () => {
  it('accepts a grounded question and lists what it verified', () => {
    const r = validateQuestion(q({}), chunks);
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.code === 'err.evidence.quote_not_found')).toMatchObject({ ok: true });
  });

  it('rejects a fabricated quote', () => {
    const r = validateQuestion(q({ evidence: [{ chunkId: 1, quote: 'אינסולין מופרש מהכבד ומעלה את רמת השומן' }] }), chunks);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('err.evidence.quote_not_found');
    expect(r.checks.find((c) => c.code === 'err.evidence.quote_not_found')?.message).toMatch(/ייתכן שהומצא/);
  });

  it('matches quotes through niqqud, quote/dash variants, bidi marks and whitespace', () => {
    const quote = '  אִינְסוּלִין - הורמון   שמופרש\u{200F} מתאי בטא בלבלב  ';
    expect(validateQuestion(q({ evidence: [{ chunkId: 1, quote }] }), chunks).ok).toBe(true);
    expect(validateQuestion(q({ evidence: [{ chunkId: 1, quote: 'אינסולין -> קולטן אינסולין => GLUT4' }] }), chunks).ok).toBe(true);
    expect(validateQuestion(q({ evidence: [{ chunkId: 5, quote: 'a KINASE is an enzyme' }] }), chunks).ok).toBe(true);
  });

  it('accepts an elided quote with a warning, and a heading as a quote', () => {
    const r = validateQuestion(q({ evidence: [{ chunkId: 1, quote: 'אינסולין – הורמון שמופרש ... ומוריד את רמת הסוכר בדם' }] }), chunks);
    expect(r.ok).toBe(true);
    expect(codes(r)).toContain('warn.evidence.quote_elided');
    expect(validateTopic({ name: 'Enzymes', parentName: null, description: null, syllabusOrder: null, evidence: [{ chunkId: 5, quote: 'Enzymes' }] }, chunks).ok).toBe(true);
  });

  it('rejects missing evidence, unknown chunks, invalid kinds and empty sides', () => {
    expect(codes(validateQuestion(q({ evidence: [] }), chunks))).toContain('err.evidence.missing');
    expect(codes(validateQuestion(q({ evidence: [{ chunkId: 999, quote: 'אינסולין' }] }), chunks))).toContain('err.evidence.chunk');
    expect(codes(validateQuestion(q({ kind: 'trivia' as never }), chunks))).toContain('err.kind.invalid');
    expect(codes(validateQuestion(q({ answer: '  ' }), chunks))).toContain('err.answer.empty');
    expect(codes(validateQuestion(q({ prompt: '' }), chunks))).toContain('err.prompt.empty');
  });

  it('rejects a cloze without [[ ]]', () => {
    const bad = validateQuestion(q({ kind: 'cloze', prompt: 'אינסולין – הורמון שמופרש מתאי בטא', answer: 'אינסולין' }), chunks);
    expect(bad.ok).toBe(false);
    expect(codes(bad)).toContain('err.cloze.no_blank');
    const good = validateQuestion(q({ kind: 'cloze', prompt: '[[אינסולין]] – הורמון שמופרש מתאי בטא', answer: 'אינסולין' }), chunks);
    expect(good.ok).toBe(true);
    const leak = validateQuestion(q({ kind: 'cloze', prompt: '[[אינסולין]] – הורמון; אינסולין מוריד סוכר', answer: 'אינסולין' }), chunks);
    expect(codes(leak)).toContain('warn.prompt.leaks_answer');
  });

  it('warns — but does not fail — on weak authority, missing key points and ungrounded answers', () => {
    const exam = validateQuestion(q({ evidence: [{ chunkId: 8, quote: 'PCR – שיטה להגברת מקטעי DNA במבחנה' }], answer: 'שיטה להגברת מקטעי DNA' }), chunks);
    expect(exam.ok).toBe(true);
    expect(codes(exam)).toContain('warn.source.past_exam_only');
    expect(exam.checks.find((c) => c.code === 'warn.source.past_exam_only')?.message).toBe('מבחן קודם בלבד — לא מקור סמכותי יחיד');

    const student = validateQuestion(q({ evidence: [{ chunkId: 4, quote: 'אינסולין – הורמון שמעלה את רמת הסוכר בדם' }], answer: 'הורמון שמעלה את רמת הסוכר' }), chunks);
    expect(codes(student)).toContain('warn.source.student_summary_only');

    const mixed = validateQuestion(
      q({ evidence: [{ chunkId: 4, quote: 'אינסולין – הורמון' }, { chunkId: 1, quote: 'אינסולין – הורמון שמופרש מתאי בטא' }] }),
      chunks,
    );
    expect(codes(mixed).filter((c) => c.startsWith('warn.source'))).toEqual([]);

    const causal = validateQuestion(q({ kind: 'causal', keyPoints: [] }), chunks);
    expect(causal.ok).toBe(true);
    expect(codes(causal)).toContain('warn.keypoints.missing');

    const invented = validateQuestion(q({ answer: 'חלבון מבני שמייצב את שלד התא בנוירונים' }), chunks);
    expect(invented.ok).toBe(true);
    expect(invented.checks.find((c) => c.code === 'warn.answer.not_in_source')?.message).toMatch(/^התשובה לא נמצאה במקור המצוטט/);
  });

  it('checks pathway completeness and order', () => {
    const base = { template: 'pathway' as const, fields: { source: 'אינסולין', signal: 'קולטן אינסולין', target: 'GLUT4', outcome: 'קליטת גלוקוז' } };
    expect(codes(validateQuestion(q({ kind: 'recall', keyPoints: ['x'], structure: base }), chunks))).not.toContain('warn.structure.missing');
    const missing = validateQuestion(q({ kind: 'recall', keyPoints: ['x'], structure: { ...base, fields: { source: 'אינסולין', signal: 'קולטן', outcome: 'קליטה' } } }), chunks);
    expect(missing.ok).toBe(true);
    expect(missing.checks.find((c) => c.code === 'warn.structure.missing')?.message).toContain('מטרה');
    const reordered = validateQuestion(q({ kind: 'recall', keyPoints: ['x'], structure: { template: 'pathway', fields: { outcome: 'a', source: 'b', signal: 'c', target: 'd' } } }), chunks);
    expect(codes(reordered)).toContain('warn.structure.order');
    expect(codes(validateQuestion(q({ structure: { template: 'story' as never, fields: {} } }), chunks))).toContain('err.structure.template');
  });

  it('validates units, topics and conflicts', () => {
    const u: UnitSuggestion = { title: 'אינסולין', content: 'אינסולין – הורמון שמופרש מתאי בטא', topicName: 'איתות תאי', evidence: q({}).evidence, questions: [q({})] };
    expect(validateUnit(u, chunks).ok).toBe(true);
    expect(codes(validateUnit({ ...u, questions: [q({ evidence: [] })] }, chunks))).toContain('warn.unit.questions_failed');
    expect(validateUnit({ ...u, title: '' }, chunks).ok).toBe(false);

    const fakeTopic = validateTopic({ name: 'גנטיקה', parentName: null, description: null, syllabusOrder: 4, evidence: [{ chunkId: 3, quote: 'שבוע 4: גנטיקה' }] }, chunks);
    expect(fakeTopic.ok).toBe(false);

    const one = validateConflict({ description: 'סתירה', evidence: [{ chunkId: 1, quote: 'אינסולין – הורמון' }] }, chunks);
    expect(codes(one)).toContain('err.conflict.evidence_count');
    const sameSource = validateConflict({ description: 'סתירה', evidence: [{ chunkId: 1, quote: 'אינסולין – הורמון' }, { chunkId: 2, quote: 'תעבורה פעילה' }] }, chunks);
    expect(sameSource.ok).toBe(true);
    expect(codes(sameSource)).toContain('warn.conflict.same_source');
  });
});

// ---------- Ollama ----------

interface Call {
  url: string;
  init?: RequestInit;
  body: Record<string, unknown> | null;
}

function stubFetch(handler: (call: Call, n: number) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(input), init, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null };
    calls.push(call);
    return handler(call, calls.length);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function chatResponse(content: unknown): Response {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return new Response(JSON.stringify({ model: 'qwen2.5:7b-instruct', message: { role: 'assistant', content: text }, done: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const goodUnit = {
  title: 'אינסולין',
  content: 'הורמון שמופרש מתאי בטא ומוריד את רמת הסוכר',
  topicName: 'איתות תאי',
  evidence: [{ chunkId: 1, quote: 'אינסולין – הורמון שמופרש מתאי בטא בלבלב ומוריד את רמת הסוכר בדם' }],
  questions: [
    {
      kind: 'definition',
      prompt: 'מהו אינסולין?',
      answer: 'הורמון שמופרש מתאי בטא בלבלב ומוריד את רמת הסוכר בדם',
      explanation: null,
      hint: null,
      keyPoints: [],
      structure: null,
      evidence: [{ chunkId: 1, quote: 'אינסולין – הורמון שמופרש מתאי בטא בלבלב ומוריד את רמת הסוכר בדם' }],
    },
  ],
};

function ollama(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof OllamaProvider>[0]> = {}) {
  return new OllamaProvider({ url: 'http://127.0.0.1:11434/', model: 'qwen2.5:7b-instruct', fetchImpl, ...extra });
}

describe('OllamaProvider', () => {
  it('sends chunks with ids, a JSON schema and low temperature, and parses a good response', async () => {
    const { fetchImpl, calls } = stubFetch(() => chatResponse({ units: [goodUnit], conflicts: [] }));
    const out = await ollama(fetchImpl).suggestUnits(unitsInput({ chunks: [signaling], style: [{ kind: 'definition', prompt: 'ריבוזום', answer: 'אברון' }] }));

    expect(out.units).toHaveLength(1);
    expect(out.units[0]).toMatchObject({ title: 'אינסולין', topicName: 'איתות תאי' });
    expect(validateUnit(out.units[0], chunks).ok).toBe(true);

    expect(calls).toHaveLength(1);
    const { url, init, body } = calls[0];
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect(init?.method).toBe('POST');
    expect(body).toMatchObject({ model: 'qwen2.5:7b-instruct', stream: false, options: { temperature: 0.2 } });
    expect(body?.format).toMatchObject({ type: 'object', required: ['units', 'conflicts'] });
    const messages = body?.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0].content).toContain('מילה במילה');
    expect(messages[0].content).toContain('source (מקור) → signal (אות) → target (מטרה) → outcome (תוצאה)');
    expect(messages[1].content).toContain('<chunk id="1"');
    expect(messages[1].content).toContain('GLUT4');
    expect(messages[1].content).toContain('צד א: ריבוזום');
  });

  it('keeps the good items of a partially malformed response', async () => {
    const messy = {
      units: [
        goodUnit,
        { content: 'אין כותרת', questions: [] },
        'not an object',
        {
          title: 'קולטן',
          content: 'חלבון שנקשר למולקולת אות',
          evidence: [{ chunkId: '1', quote: 'קולטן הוא חלבון שנקשר למולקולת אות ומעביר את האות לתוך התא.' }],
          questions: [
            { kind: 'trivia', prompt: 'x', answer: 'y' },
            { kind: 'definition', prompt: '', answer: 'חסר נוסח' },
            { kind: 'הסבר סיבתי', prompt: 'מה עושה קולטן?', answer: 'מעביר את האות לתוך התא', keyPoints: ['קישור', 5], structure: { template: 'magic' } },
            { kind: 'recall', prompt: 'מסלול', answer: 'א → ב', keyPoints: ['א'], structure: { template: 'pathway', fields: { outcome: 'ד', source: 'א', extra: 'z' } } },
          ],
        },
      ],
      conflicts: [{ description: 'רק ציטוט אחד', evidence: [{ chunkId: 1, quote: 'אינסולין' }] }, { evidence: [] }],
    };
    const { fetchImpl } = stubFetch(() => chatResponse('```json\n' + JSON.stringify(messy) + '\n```'));
    const out = await ollama(fetchImpl).suggestUnits(unitsInput({ chunks: [signaling] }));

    expect(out.units.map((u) => u.title)).toEqual(['אינסולין', 'קולטן']);
    const receptor = out.units[1];
    expect(receptor.questions.map((x) => x.kind)).toEqual(['causal', 'recall']);
    expect(receptor.questions[0]).toMatchObject({ keyPoints: ['קישור'], structure: null });
    // Questions without their own evidence inherit the unit's.
    expect(receptor.questions[0].evidence).toEqual([{ chunkId: 1, quote: 'קולטן הוא חלבון שנקשר למולקולת אות ומעביר את האות לתוך התא.' }]);
    // Structure fields are rebuilt in template order, unknown fields dropped.
    expect(Object.keys(receptor.questions[1].structure?.fields ?? {})).toEqual(['source', 'outcome']);
    expect(out.conflicts).toEqual([]);
  });

  it('batches large inputs and merges units proposed twice', async () => {
    const big = (id: number): ChunkRef => ({ ...signaling, chunkId: id, text: `פסקה ${id}\n${'תא '.repeat(1200)}` });
    const { fetchImpl, calls } = stubFetch(() => chatResponse({ units: [goodUnit], conflicts: [] }));
    const out = await ollama(fetchImpl).suggestUnits(unitsInput({ chunks: [big(1), big(2), big(3)] }));
    expect(calls.length).toBe(3);
    for (const c of calls) {
      const user = (c.body?.messages as { content: string }[])[1].content;
      const chunkText = [...user.matchAll(/<chunk[^>]*>\n([\s\S]*?)\n<\/chunk>/g)].reduce((n, m) => n + m[1].length, 0);
      expect(chunkText).toBeLessThanOrEqual(6000);
    }
    expect(out.units).toHaveLength(1);
  });

  it('skips an unparseable batch but fails when nothing parses', async () => {
    const big = (id: number): ChunkRef => ({ ...signaling, chunkId: id, text: 'תא '.repeat(2500) });
    const half = stubFetch((_c, n) => (n === 1 ? chatResponse('סליחה, אני לא יכול') : chatResponse({ units: [goodUnit], conflicts: [] })));
    expect((await ollama(half.fetchImpl).suggestUnits(unitsInput({ chunks: [big(1), big(2)] }))).units).toHaveLength(1);

    const none = stubFetch(() => chatResponse('not json at all'));
    await expect(ollama(none.fetchImpl).suggestUnits(unitsInput({ chunks: [signaling] }))).rejects.toThrow('המודל החזיר פלט שאינו JSON תקין');
  });

  it('maps connection errors, timeouts and a missing model to Hebrew errors', async () => {
    const refused = stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    await expect(ollama(refused.fetchImpl).suggestUnits(unitsInput({ chunks: [signaling] }))).rejects.toThrow(/לא ניתן להתחבר ל־Ollama בכתובת http:\/\/127\.0\.0\.1:11434/);

    const slow = stubFetch(() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')));
    await expect(ollama(slow.fetchImpl, { timeoutMs: 30_000 }).suggestTopics({ course: 'x', chunks: [signaling], existingTopics: [] })).rejects.toThrow(
      'המודל לא הגיב בתוך 30 שניות',
    );

    const missing = stubFetch(() => new Response(JSON.stringify({ error: "model 'qwen2.5:7b-instruct' not found" }), { status: 404 }));
    await expect(ollama(missing.fetchImpl).suggestUnits(unitsInput({ chunks: [signaling] }))).rejects.toThrow('ollama pull qwen2.5:7b-instruct');
  });

  it('available() checks that the model is installed', async () => {
    const tags = (names: string[]) => stubFetch(() => new Response(JSON.stringify({ models: names.map((name) => ({ name, model: name })) }), { status: 200 }));

    const without = tags(['llama3.2:latest']);
    const r = await ollama(without.fetchImpl).available();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('ollama pull qwen2.5:7b-instruct');
    expect(r.detail).toContain('llama3.2:latest');
    expect(without.calls[0].url).toBe('http://127.0.0.1:11434/api/tags');

    expect((await ollama(tags(['qwen2.5:7b-instruct']).fetchImpl).available()).ok).toBe(true);
    expect((await ollama(tags(['llama3.2:latest']).fetchImpl, { model: 'llama3.2' }).available()).ok).toBe(true);

    const down = await ollama(stubFetch(() => Promise.reject(new TypeError('fetch failed'))).fetchImpl).available();
    expect(down).toMatchObject({ ok: false });
    expect(down.detail).toMatch(/Ollama לא פועל/);
  });

  it('parses topics, drops existing ones, and leaves grounding to the validator', async () => {
    const { fetchImpl } = stubFetch(() =>
      chatResponse({
        topics: [
          { name: 'מבוא לתא', parentName: null, description: null, syllabusOrder: 1, evidence: [{ chunkId: 3, quote: 'שבוע 1: מבוא לתא' }] },
          { name: 'איתות תאי', parentName: null, description: null, syllabusOrder: '3', evidence: [{ chunkId: 3, quote: 'שבוע 3: איתות תאי' }] },
          { name: 'גנטיקה', parentName: null, description: null, syllabusOrder: -2, evidence: [{ chunkId: 3, quote: 'שבוע 5: גנטיקה' }] },
          { parentName: null },
        ],
      }),
    );
    const topics = await ollama(fetchImpl).suggestTopics({ course: 'ביולוגיה של התא', chunks: [syllabus], existingTopics: ['איתות תאי'] });
    expect(topics.map((t) => t.name)).toEqual(['מבוא לתא', 'גנטיקה']);
    expect(topics[1].syllabusOrder).toBeNull();
    expect(validateTopic(topics[0], chunks).ok).toBe(true);
    expect(codes(validateTopic(topics[1], chunks))).toContain('err.evidence.quote_not_found');
  });
});

describe('getProvider', () => {
  it('returns the configured provider', () => {
    expect(getProvider({ aiProvider: 'mock', ollamaUrl: '', ollamaModel: '' })).toBeInstanceOf(MockProvider);
    const p = getProvider({ aiProvider: 'ollama', ollamaUrl: 'http://localhost:11434', ollamaModel: 'qwen2.5:7b-instruct' });
    expect(p).toBeInstanceOf(OllamaProvider);
    expect(p.id).toBe('ollama');
    expect(p.label).toContain('qwen2.5:7b-instruct');
  });
});
