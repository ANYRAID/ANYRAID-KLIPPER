import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { transformDocsMarkdown } from '../src/diagnostics/docs-markdown.ts';

const bytes = readFileSync(new URL('../contracts/docs-markdown-reference.json.gz', import.meta.url));
const fixtureSha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(fixtureSha256, '5dc3f6a017e70b2fa3d579600749bf5324c49ff24deae97f1e400bb06521a6f7');
const fixture: { cases: { name: string; input: string; repoUrl: string; outputSha256: string }[] } =
  JSON.parse(gunzipSync(bytes).toString());
for (const item of fixture.cases) {
  assert.equal(createHash('sha256').update(transformDocsMarkdown(item.input, item.repoUrl))
    .digest('hex'), item.outputSha256, item.name);
}
const samplesMs: number[] = [];
let outputLength = 0;
for (let run = 0; run < 10; run++) {
  const start = performance.now();
  for (const item of fixture.cases) outputLength += transformDocsMarkdown(item.input, item.repoUrl).length;
  if (run >= 3) samplesMs.push(performance.now() - start);
}
assert.ok(outputLength > 0);
console.log(JSON.stringify({ node: process.version, fixtureSha256, cases: fixture.cases.length,
  inputBytes: fixture.cases.reduce((sum, item) => sum + Buffer.byteLength(item.input), 0),
  warmups: 3, samplesMs, medianMs: samplesMs.toSorted((a, b) => a - b)[3], outputLength }, null, 2));
