import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { buildTranslatedDocs } from '../src/diagnostics/docs-translations.ts';
if (process.argv.length !== 3) throw new Error('Usage: node host/bench/docs-translations.ts TRANSLATIONS_DIRECTORY');
const root = await mkdtemp(join(tmpdir(), 'docs-translations-bench-'));
const repo = resolve(import.meta.dirname, '../..');
const samplesMs: number[] = [];
let result;
try {
  for (let round = 0; round < 10; round++) {
    const start = performance.now();
    result = await buildTranslatedDocs({ docs: join(repo, 'docs'),
      config: join(repo, 'docs/_klipper3d/site.yml'), translations: resolve(process.argv[2]), output: join(root, String(round)) });
    if (round >= 3) samplesMs.push(performance.now() - start);
  }
  console.log(JSON.stringify({ node: process.version, warmups: 3, samplesMs,
    medianMs: samplesMs.toSorted((a, b) => a - b)[3], result,
    scope: 'Multilingual candidate build, staging and filesystem writes; no download or browser time' }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
