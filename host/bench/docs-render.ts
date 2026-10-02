import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { renderDocsPage } from '../src/diagnostics/docs-render.ts';

const bytes = readFileSync(new URL('../contracts/docs-markdown-reference.json.gz', import.meta.url));
const fixtureSha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(fixtureSha256, '5dc3f6a017e70b2fa3d579600749bf5324c49ff24deae97f1e400bb06521a6f7');
const fixture: { cases: { name: string; input: string; repoUrl: string }[] } = JSON.parse(gunzipSync(bytes).toString());
const pages = fixture.cases.filter((item) => item.name.startsWith('docs/'));
const samplesMs: number[] = [];
let outputBytes = 0, referenceHash: string | undefined;
for (let run = 0; run < 10; run++) {
  const output: string[] = [];
  const start = performance.now();
  for (const page of pages) output.push(JSON.stringify(renderDocsPage(page.input, page.repoUrl)));
  const elapsed = performance.now() - start;
  const combined = output.join('\n');
  const hash = createHash('sha256').update(combined).digest('hex');
  if (referenceHash === undefined) referenceHash = hash;
  else assert.equal(hash, referenceHash, `Non-deterministic render at round ${run}`);
  outputBytes = Buffer.byteLength(combined);
  if (run >= 3) samplesMs.push(elapsed);
}
console.log(JSON.stringify({ node: process.version, fixtureSha256, pages: pages.length,
  inputBytes: pages.reduce((sum, page) => sum + Buffer.byteLength(page.input), 0),
  warmups: 3, samplesMs, medianMs: samplesMs.toSorted((a, b) => a - b)[3],
  outputBytes, outputSha256: referenceHash,
  scope: 'Markdown HTML rendering and page metadata only; not a whole-site or print benchmark.' }, null, 2));
