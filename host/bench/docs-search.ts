import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { searchDocs } from '../src/diagnostics/docs-search.ts';
import { renderDocsPage } from '../src/diagnostics/docs-render.ts';
const fixture = JSON.parse(gunzipSync(readFileSync(new URL('../contracts/docs-markdown-reference.json.gz', import.meta.url))).toString());
const entries = fixture.cases.filter((item: { name: string }) => item.name.startsWith('docs/'))
  .map((item: { name: string; input: string; repoUrl: string }) => {
    const page = renderDocsPage(item.input, item.repoUrl);
    return { title: page.title, text: page.text, url: item.name };
  });
assert.equal(searchDocs(entries, 'pressure advance')[0].url, 'docs/Pressure_Advance.md');
const queries = ['pressure advance', 'bed mesh', '运动精度', 'SET_PRESSURE_ADVANCE', 'not-found-unique-phrase'];
const samplesMs: number[] = [];
for (let run = 0; run < 10; run++) {
  const start = performance.now();
  for (const query of queries) searchDocs(entries, query);
  if (run >= 3) samplesMs.push((performance.now() - start) / queries.length);
}
console.log(JSON.stringify({ node: process.version, pages: entries.length, queries,
  warmups: 3, samplesMsPerQuery: samplesMs, medianMsPerQuery: samplesMs.toSorted((a, b) => a - b)[3],
  scope: 'Node search computation; browser rendering and fetching excluded' }, null, 2));
