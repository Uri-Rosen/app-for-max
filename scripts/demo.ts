// Runs the app against the demo database (./data-demo) on a separate port,
// so the demo can be explored side by side with the real app.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.MEMORY_DATA_DIR ??= path.join(root, 'data-demo');
process.env.MEMORY_PORT ??= '4318';
await import('../server/main.ts');
