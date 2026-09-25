# Working rules for this repository

Read `README.md` for what the app is and `docs/spec.he.md` for the plan it implements. This file is only the rules an agent must not break.

- **`data/` is the user's real database.** Never delete, reset or seed it. Tests use a temp dir; the demo uses `data-demo/` (`npm run seed:demo -- --reset`, `npm run demo` on port 4318).
- **The scheduler is pure and lives in `shared/`.** `shared/scheduler.ts`, `planner.ts`, `questionPick.ts` take state in and give decisions out, with Hebrew reasons for every rule that fired. No I/O, no clock, no randomness. Any change to scheduling behaviour needs a test in `tests/scheduler.test.ts` and must keep every decision explainable.
- **The AI only suggests.** Nothing under `server/ai/` may approve, schedule or compute dates. Suggestions become `proposed` topics/units and `pending` questions with a validation report; approval of AI questions requires `verified: true`. Grounding failures (`err.` checks) block approval unless the user explicitly overrides.
- **Every user-meaningful write goes through `record()` in `server/audit.ts`.** That is what makes it appear in the action log and undoable. Bulk bookkeeping (extracted chunks, the day log) is the only exception.
- **Nothing is hard-deleted.** Units are archived, questions rejected, topics merged (old name kept as an alias). Source files are only ever read; uploads are copied once into `data/sources/` and never rewritten.
- **Server code runs as TypeScript directly** (Node ≥ 22.18 type stripping): erasable syntax only — no `enum`, `namespace`, parameter properties or decorators; relative imports include `.ts`; `import type` for types.
- **UI is Hebrew, RTL.** User-facing strings in Hebrew; use `pre()` and `count()` from `shared/labels.ts` for prefixes and plurals; `dir="auto"` on user or extracted text; colours only via the CSS variables in `web/src/styles.css`.
- **Gate before calling something done:** `npm run typecheck`, `npm test`, `npm run build`, and look at the change in the running app.
