// Stage 2 of the plan: fill a course with sample data and three weeks of
// simulated study — including skipped days, hints, wrong answers, a source
// conflict and a pending AI suggestion — so load, missed reviews and restore
// can be tried without touching real data.
//
// Writes to ./data-demo (never ./data). Run: npm run seed:demo [-- --reset]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.MEMORY_DATA_DIR ??= path.join(root, 'data-demo');
const dataDir = path.resolve(process.env.MEMORY_DATA_DIR);
if (path.resolve(dataDir) === path.join(root, 'data')) {
  console.error('seed-demo refuses to write into ./data — that is the real database.');
  process.exit(1);
}

const dbFile = path.join(dataDir, 'memory.db');
if (fs.existsSync(dbFile)) {
  if (!process.argv.includes('--reset')) {
    console.error(`${dbFile} already exists. Run with --reset to rebuild the demo.`);
    process.exit(1);
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const { openDb, closeDb, run } = await import('../server/db/index.ts');
const { record } = await import('../server/audit.ts');
const { setClockOffsetDays, today, updateSettings } = await import('../server/services/settings.ts');
const S = await import('../server/services/structure.ts');
const U = await import('../server/services/units.ts');
const { getToday, submitReview } = await import('../server/services/session.ts');
const { importCards } = await import('../server/services/proposals.ts');
const { backupNow } = await import('../server/services/backup.ts');

openDb(dbFile);
updateSettings({ budgetMinutes: 15, maxItems: 12 });

const DAY0 = -21;
setClockOffsetDays(DAY0);
const d = (offset: number) => {
  const base = new Date(`${today()}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + offset - DAY0);
  return base.toISOString().slice(0, 10);
};

const course = S.createCourse({ name: 'ביולוגיה של התא (הדגמה)', code: 'BIO-101', term: 'סמסטר א׳', examDate: d(40), color: '#2f5d62' });
const membranes = S.createTopic({ courseId: course.id, name: 'ממברנות והובלה', foundational: true });
const signaling = S.createTopic({ courseId: course.id, name: 'איתות תאי', importance: 'core' });
const methods = S.createTopic({ courseId: course.id, name: 'שיטות מחקר' });
const cycle = S.createTopic({ courseId: course.id, name: 'מחזור התא' });
const checkpoints = S.createTopic({ courseId: course.id, name: 'נקודות בקרה', parentId: cycle.id });
const dupTopic = S.createTopic({ courseId: course.id, name: 'איתות בין תאים' });

const l1 = S.createLesson({ courseId: course.id, title: 'הרצאה 1 — ממברנות', studiedOn: d(-20), topicIds: [membranes.id] });
const l2 = S.createLesson({ courseId: course.id, title: 'הרצאה 2 — הובלה ואיתות', studiedOn: d(-13), topicIds: [membranes.id, signaling.id] });
const l3 = S.createLesson({ courseId: course.id, title: 'הרצאה 3 — איתות (המשך) ושיטות', studiedOn: d(-6), topicIds: [signaling.id, methods.id] });
const l4 = S.createLesson({ courseId: course.id, title: 'הרצאה 4 — מחזור התא', studiedOn: d(-2), topicIds: [cycle.id, checkpoints.id] });

// A manual "slides" source so units can cite where their answers come from.
const { result: slides } = record({ action: 'source.create', summary: 'מקור הדגמה' }, (cs) =>
  cs.insert('sources', {
    course_id: course.id,
    kind: 'slides',
    title: 'מצגות הקורס (הדגמה)',
    origin: 'manual',
    status: 'approved',
    added_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
  }),
);
const { result: studentSummary } = record({ action: 'source.create', summary: 'מקור הדגמה' }, (cs) =>
  cs.insert('sources', {
    course_id: course.id,
    kind: 'student_summary',
    title: 'סיכום של סטודנט משנה שעברה (הדגמה)',
    origin: 'manual',
    status: 'approved',
    added_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
  }),
);

type Q = Record<string, unknown>;
function unit(topicId: number, lessonId: number, learnedOn: string, title: string, content: string, questions: Q[], cite?: { locator: string; quote: string }) {
  const u = U.createUnit({ topicId, lessonId, learnedOn, title, content, questions: questions.map((q) => ({ provenance: 'official', ...q })) });
  if (cite) U.addLink({ entityType: 'unit', entityId: u.unit.id, sourceId: slides, role: 'supports', ...cite });
  return u.unit.id;
}

const ids: Record<string, number> = {};
ids.facilitated = unit(membranes.id, l1.id, d(-20), 'דיפוזיה מוקלת', 'מעבר חומר דרך הממברנה במורד מפל הריכוז בעזרת חלבון נשא או תעלה, בלי השקעת אנרגיה.', [
  { kind: 'definition', prompt: 'דיפוזיה מוקלת', answer: 'מעבר חומר דרך הממברנה במורד מפל הריכוז בעזרת חלבון נשא או תעלה, בלי השקעת אנרגיה.' },
  {
    kind: 'comparison',
    prompt: 'מה ההבדל בין דיפוזיה מוקלת להובלה פעילה?',
    answer: 'בדיפוזיה מוקלת החומר נע במורד מפל הריכוז בלי השקעת אנרגיה; בהובלה פעילה הוא מועבר נגד מפל הריכוז תוך השקעת אנרגיה (לרוב ATP). בשתיהן מעורבים חלבוני ממברנה.',
    keyPoints: ['כיוון ביחס למפל הריכוז', 'השקעת אנרגיה', 'בשתיהן יש חלבוני ממברנה'],
  },
], { locator: 'שקופית 9', quote: 'דיפוזיה מוקלת: מעבר במורד מפל הריכוז דרך חלבוני נשא ותעלות, ללא ATP' });

ids.pump = unit(membranes.id, l2.id, d(-13), 'משאבת נתרן–אשלגן', 'מוציאה 3 יוני Na⁺ ומכניסה 2 יוני K⁺ לכל מולקולת ATP שמפורקת.', [
  { kind: 'cloze', prompt: 'משאבת נתרן–אשלגן מוציאה [[3]] יוני נתרן ומכניסה [[2]] יוני אשלגן לכל ATP שמפורק.', answer: '' },
  {
    kind: 'causal',
    prompt: 'מה יקרה לפוטנציאל המנוחה אם משאבת נתרן–אשלגן תעוכב לאורך זמן, ולמה?',
    answer: 'מפלי הריכוז של נתרן ואשלגן יתמסמסו בהדרגה, ולכן פוטנציאל המנוחה יתקרב לאפס (דה־פולריזציה). המשאבה עצמה תורמת ישירות מעט, אבל היא ששומרת על המפלים שעליהם נשען הפוטנציאל.',
    keyPoints: ['המפלים נעלמים בהדרגה', 'הפוטנציאל מתקרב לאפס', 'התרומה הישירה של המשאבה קטנה'],
  },
], { locator: 'שקופית 14', quote: '3Na⁺ החוצה, 2K⁺ פנימה, ATP אחד לכל מחזור' });

ids.insulin = unit(signaling.id, l2.id, d(-13), 'מסלול האינסולין', 'אינסולין מתאי בטא נקשר לקולטן על תאי שריר ושומן ומביא להצבת GLUT4 בממברנה.', [
  {
    kind: 'recall',
    prompt: 'תאר את מסלול האיתות של אינסולין, מהמקור ועד התוצאה.',
    answer: 'תאי בטא בלבלב מפרישים אינסולין → האינסולין נקשר לקולטן אינסולין (קולטן טירוזין קינאז) על תאי שריר ושומן → מפל איתות תוך־תאי מביא להצבת נשאי GLUT4 בממברנה → הגלוקוז נכנס לתאים ורמת הסוכר בדם יורדת.',
    structure: {
      template: 'pathway',
      fields: {
        source: 'תאי בטא בלבלב',
        signal: 'אינסולין',
        target: 'קולטן אינסולין (טירוזין קינאז) בתאי שריר ושומן',
        outcome: 'הצבת GLUT4 בממברנה, קליטת גלוקוז וירידת הסוכר בדם',
      },
      analogy: 'אינסולין כמו מפתח שפותח דלתות (GLUT4) שמחכות במחסן בתוך התא.',
    },
  },
  {
    kind: 'causal',
    prompt: 'מה יקרה לקליטת הגלוקוז בתאי שריר אם הקולטן לאינסולין פגום, ולמה?',
    answer: 'הקליטה תרד: בלי הפעלת הקולטן לא מתחיל מפל האיתות שמביא להצבת GLUT4 בממברנה, ולכן פחות גלוקוז נכנס לתא ורמת הסוכר בדם נשארת גבוהה.',
    keyPoints: ['אין הפעלה של מפל האיתות', 'GLUT4 לא מגיע לממברנה', 'הסוכר בדם נשאר גבוה'],
    hint: 'מה צריך לקרות ל־GLUT4?',
  },
], { locator: 'שקופית 21', quote: 'אינסולין ← קולטן טירוזין קינאז ← הצבת GLUT4 ← קליטת גלוקוז' });

ids.camp = unit(signaling.id, l3.id, d(-6), 'שליח שני cAMP', 'cAMP נוצר מ־ATP על ידי אדניליל ציקלאז אחרי הפעלת קולטן מצומד לחלבון G, ומפעיל את PKA.', [
  { kind: 'cloze', prompt: 'האנזים [[אדניליל ציקלאז]] הופך ATP ל־cAMP.', answer: '' },
  {
    kind: 'definition',
    prompt: 'cAMP',
    answer: 'שליח שני שנוצר מ־ATP על ידי אדניליל ציקלאז לאחר הפעלת קולטן מצומד לחלבון G, ומפעיל את חלבון קינאז A (PKA).',
  },
], { locator: 'שקופית 6', quote: 'GPCR ← Gs ← אדניליל ציקלאז ← cAMP ← PKA' });

ids.amplification = unit(signaling.id, l3.id, d(-6), 'הגברת אות', 'בכל שלב של מפל איתות מולקולה אחת מפעילה רבות.', [
  {
    kind: 'recall',
    prompt: 'איך מפל איתות מגביר אות?',
    answer: 'כל מולקולה שמופעלת בשלב אחד מפעילה מולקולות רבות בשלב הבא — למשל אדניליל ציקלאז אחד מייצר מולקולות cAMP רבות — כך שמעט מולקולות אות גורמות לתגובה גדולה.',
    keyPoints: ['אחת מפעילה רבות', 'דוגמה: אנזים מייצר הרבה שליח שני', 'אות קטן → תגובה גדולה'],
  },
]);

ids.western = unit(methods.id, l3.id, d(-6), 'Western blot', 'שיטה לזיהוי חלבון מסוים וכמותו היחסית בעזרת נוגדן.', [
  {
    kind: 'recall',
    prompt: 'מה מודדת שיטת Western blot, ומה היא לא מוכיחה?',
    answer: 'היא מודדת נוכחות וכמות יחסית של חלבון מסוים לפי גודלו, בעזרת נוגדן ספציפי. היא לא מוכיחה שהחלבון פעיל ולא מראה איפה בתא הוא נמצא.',
    structure: {
      template: 'method',
      fields: {
        measures: 'נוכחות וכמות יחסית של חלבון מסוים, לפי גודל, בעזרת נוגדן',
        supports: 'פס חזק יותר בדגימה מטופלת תומך בכך שרמת החלבון עלתה',
        notProves: 'לא מוכיח שהחלבון פעיל, ולא מראה את מיקומו בתא',
        controls: 'בקרת העמסה (למשל אקטין); בקרה חיובית ושלילית לנוגדן',
      },
    },
  },
  {
    kind: 'interpretation',
    prompt: 'ב־Western blot, הפס של חלבון X חזק פי 3 בתאים שטופלו באינסולין, והפס של אקטין זהה בכל הדגימות. מה אפשר להסיק ומה לא?',
    answer: 'אפשר להסיק שרמת החלבון X עלתה בעקבות הטיפול, כי אקטין זהה ולכן הועמסה כמות חלבון דומה. אי אפשר להסיק שהחלבון פעיל יותר, או באיזה מנגנון הרמה עלתה.',
    keyPoints: ['X עלה', 'אקטין = בקרת העמסה', 'לא מעיד על פעילות', 'לא מעיד על מנגנון'],
  },
], { locator: 'שקופית 30', quote: 'Western blot — כמות חלבון יחסית; תמיד עם בקרת העמסה' });

ids.gfp = unit(methods.id, l3.id, d(-6), 'GFP', 'חלבון פלואורסצנטי ירוק לסימון חלבונים בתאים חיים.', [
  { kind: 'definition', prompt: 'GFP', answer: 'חלבון פלואורסצנטי ירוק שמקורו במדוזה, משמש לסימון חלבונים ולמעקב אחר מיקומם בתאים חיים.' },
]);

ids.p53 = unit(checkpoints.id, l4.id, d(-2), 'p53', 'מדכא גידולים שעוצר את מחזור התא בתגובה לנזק ב־DNA.', [
  { kind: 'definition', prompt: 'p53', answer: 'חלבון מדכא גידולים שעוצר את מחזור התא בתגובה לנזק ב־DNA, ויכול להפעיל אפופטוזיס אם הנזק לא מתוקן.' },
  {
    kind: 'application',
    prompt: 'תא עם מוטציה שמשביתה את p53 נחשף לקרינה שפוגעת ב־DNA. מה צפוי לקרות, ולמה זה מסוכן?',
    answer: 'התא לא יעצור את המחזור לתיקון ולא יעבור אפופטוזיס, ולכן ימשיך להתחלק עם DNA פגום. מוטציות יצטברו, וזה מגביר את הסיכון לסרטן.',
    keyPoints: ['אין עצירה לתיקון', 'אין אפופטוזיס', 'הצטברות מוטציות → סיכון לסרטן'],
  },
]);

const cards = importCards({
  courseId: course.id,
  topicName: 'מונחי יסוד (Quizlet)',
  learnedOn: d(-16),
  provenance: 'official',
  text: [
    'מיטוכונדריה\tאברון שבו מתרחשת הנשימה התאית ומיוצר רוב ה־ATP בתא',
    'ריבוזום\tמבנה שמתרגם mRNA לחלבון',
    'מנגנון גולג׳י\tאברון שממיין, משנה ואורז חלבונים ושולח אותם ליעדם',
    'ליזוזום\tאברון עם אנזימי עיכול שמפרק מקרומולקולות ואברונים ישנים',
    'ציטוסקלט\tרשת סיבי חלבון שנותנת לתא צורה ותמיכה ומאפשרת תנועה והובלה בתוך התא',
    'אקסוציטוזה\tהפרשת חומרים מהתא על ידי איחוי שלפוחית עם קרום התא',
    'אנדוציטוזה\tהכנסת חומרים לתא על ידי השקעת קרום התא פנימה ויצירת שלפוחית',
    'אוסמוזה\tמעבר מים דרך ממברנה בררנית מאזור עם ריכוז מומסים נמוך לאזור עם ריכוז מומסים גבוה',
    'קולטן מצומד לחלבון G\tקולטן ממברנלי עם שבעה מקטעים חוצי ממברנה, שמפעיל חלבון G כשליגנד נקשר אליו',
    'הנשא ____ מכניס גלוקוז לתאי שריר בתגובה לאינסולין\tGLUT4',
  ].join('\n'),
});

// A duplicate topic under another name, merged — the old name stays as an alias.
S.mergeTopics(dupTopic.id, signaling.id);

// ---- simulate three weeks, skipping two days ----
let seed = 20260925;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const hard = new Set([ids.pump, ids.p53, ids.western]);
const skip = new Set([-15, -9, -8, -3]);

for (let off = DAY0; off <= -1; off++) {
  setClockOffsetDays(off);
  if (skip.has(off)) continue;
  for (let guard = 0; guard < 40; guard++) {
    const t = getToday();
    const item = t.queue[0] ?? (t.queue.length === 0 ? t.corrections[0] : undefined);
    if (!item?.question) break;
    const r = rand();
    const pWrong = hard.has(item.unitId) ? 0.3 : 0.1;
    const grade = item.isCorrection ? (r < 0.8 ? 'correct' : 'partial') : r < pWrong ? 'wrong' : r < pWrong + 0.15 ? 'partial' : r < 0.9 ? 'correct' : 'easy';
    const hintUsed = !item.isCorrection && Boolean(item.question.hint) && rand() < 0.3;
    submitReview({
      unitId: item.unitId,
      questionId: item.question.id,
      grade,
      hintUsed,
      isCorrection: item.isCorrection,
      errorType: grade === 'wrong' ? (rand() < 0.5 ? 'knowledge_gap' : 'confusion') : grade === 'partial' ? 'partial' : null,
      confusedWith: grade === 'wrong' && item.unitId === ids.pump ? 'משאבת סידן' : null,
      totalMs: Math.round(25_000 + rand() * 70_000),
      answerMs: Math.round(15_000 + rand() * 40_000),
      userAnswer: null,
    });
  }
}

setClockOffsetDays(0);
getToday(); // backfills the skipped days into the day log

// After the history: a conflicting student summary and a pending AI suggestion, to show the review screen.
U.addLink({
  entityType: 'unit',
  entityId: ids.facilitated,
  sourceId: studentSummary,
  role: 'contradicts',
  quote: 'דיפוזיה מוקלת דורשת ATP כי יש בה חלבון נשא',
  note: 'הסיכום טוען שנדרשת אנרגיה — המצגת אומרת שלא.',
});
record({ action: 'ai.suggest', summary: 'הצעת AI לדוגמה' }, (cs) => {
  const qid = U.insertQuestion(
    cs,
    {
      unitId: ids.camp,
      kind: 'causal',
      prompt: 'מה יקרה לרמת ה־cAMP בתא אם אדניליל ציקלאז מעוכב?',
      answer: 'רמת ה־cAMP תרד, כי אדניליל ציקלאז הוא האנזים שמייצר cAMP מ־ATP; בהתאם, פחות PKA יופעל.',
      keyPoints: ['פחות ייצור cAMP', 'פחות הפעלה של PKA'],
    },
    { status: 'pending', createdBy: 'ai', provenance: 'generated', validation: { ok: true, checks: [{ code: 'ok.quote', ok: true, message: 'הציטוט נמצא במקור' }] } },
  );
  U.insertLink(cs, { entityType: 'question', entityId: qid, sourceId: slides, role: 'supports', locator: 'שקופית 6', quote: 'GPCR ← Gs ← אדניליל ציקלאז ← cAMP ← PKA' });
});

run("UPDATE audit_log SET summary = summary || ' (הדגמה)' WHERE summary NOT LIKE '%הדגמה%'");
const b = backupNow('manual');
closeDb();

console.log(`Demo ready in ${dataDir}`);
console.log(`  course #${course.id}, ${Object.keys(ids).length + cards.units} units, lessons ${[l1, l2, l3, l4].map((l) => l.id).join(',')}`);
console.log(`  backup: ${b.file}`);
console.log('Start it with: npm run demo');
