// GPL-3.0-or-later. File-read + legacy test planning cost; no backend execution.
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {parseKlippyTest} from '../src/diagnostics/klippy-test.ts';
const root = fileURLToPath(new URL('../../', import.meta.url));
const files = readdirSync(join(root, 'test/klippy')).filter(f => f.endsWith('.test')).sort();
const samples: number[] = [];
let cases = 0;
for (let run = 0; run < 30; run++) {
  const start = performance.now();
  cases = 0;
  for (const file of files) {
    const path = join(root, 'test/klippy', file);
    cases += parseKlippyTest(readFileSync(path, 'utf8'), path, join(root, 'dict')).length;
  }
  const elapsed = performance.now() - start;
  if (run >= 5) samples.push(elapsed);
}
if (files.length !== 37 || cases !== 239) throw new Error('Unexpected regression corpus');
samples.sort((a, b) => a - b);
console.log(JSON.stringify({runtime: process.version, files: files.length, cases,
  medianMs: samples[12], p95Ms: samples[23], maxMs: samples[24]}));
