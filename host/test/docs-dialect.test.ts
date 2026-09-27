import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderDocsPage } from '../src/diagnostics/docs-render.ts';
const fixture = JSON.parse(readFileSync(new URL('../contracts/docs-dialect-reference.json', import.meta.url), 'utf8'));
// HTML attribute order and inter-tag whitespace are not semantic differences.
const normalize = (html: string) => html.replace(/<input([^>]+)>/g, (_, attributes: string) =>
  '<input ' + (attributes.match(/[a-z]+="[^"]*"/g) ?? []).sort().join(' ') + '>')
  .replace(/>\s+</g, '><').trim();
for (const name of ['breakless', 'indented-code', 'underscore', 'strike', 'autolink', 'table', 'headings', 'task-list']) {
  test(`legacy Markdown dialect: ${name}`, () => {
    const item = fixture.cases.find((entry: { name: string }) => entry.name === name);
    assert.ok(item);
    assert.equal(normalize(renderDocsPage(item.input, 'https://example.test/').html), normalize(item.html));
  });
}

test('checkbox markers stay literal in paragraphs, inline code and fenced examples', () => {
  const html = renderDocsPage('[x] paragraph\n\n- `[x]` inline\n\n```\n- [x] code\n```', 'https://example.test/').html;
  assert.ok(!html.includes('type="checkbox"'));
});
