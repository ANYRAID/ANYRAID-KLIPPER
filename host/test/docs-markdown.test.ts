import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { transformDocsMarkdown, type MarkdownRewrite } from '../src/diagnostics/docs-markdown.ts';

test('documentation preprocessing matches frozen Python output for every page and boundary case', () => {
  const bytes = readFileSync(new URL('../contracts/docs-markdown-reference.json.gz', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    '5dc3f6a017e70b2fa3d579600749bf5324c49ff24deae97f1e400bb06521a6f7');
  const fixture = JSON.parse(gunzipSync(bytes).toString());
  assert.equal(fixture.cases.length, 72);
  for (const item of fixture.cases) {
    const output = transformDocsMarkdown(item.input, item.repoUrl);
    assert.equal(createHash('sha256').update(output).digest('hex'), item.outputSha256, item.name);
  }
});

test('rewrite diagnostics identify changed lines without touching fenced code', () => {
  const changes: MarkdownRewrite[] = [];
  const result = transformDocsMarkdown('```\n[x](../code)\n```\n[x](../file)\ntext \\\n',
    'https://example.test/repo/', (entry) => changes.push(entry));
  assert.equal(result, '```\n[x](../code)\n```\n[x](https://example.test/repo/blob/master/file)\ntext <br>');
  assert.deepEqual(changes.map(({ line }) => line), [4, 5]);
  assert.equal(changes[1].before, 'text \\');
  assert.equal(changes[1].after, 'text <br>');
});
