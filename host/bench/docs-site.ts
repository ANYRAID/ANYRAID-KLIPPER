import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildDocsSite } from '../src/diagnostics/docs-site.ts';
const root = await mkdtemp(join(tmpdir(), 'docs-build-bench-'));
const repo = resolve(import.meta.dirname, '../..');
const samplesMs: number[] = [];
let result;
try {
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    result = await buildDocsSite({ docs: join(repo, 'docs'),
      config: join(repo, 'docs/_klipper3d/site.yml'), output: join(root, String(i)) });
    if (i >= 3) samplesMs.push(performance.now() - start);
  }
  console.log(JSON.stringify({ node: process.version, warmups: 3, samplesMs,
    medianMs: samplesMs.toSorted((a, b) => a - b)[3], result,
    scope: 'English candidate build including filesystem writes; no printer or deployment acceptance.' }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
