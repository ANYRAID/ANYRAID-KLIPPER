import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderDocsPage } from '../src/diagnostics/docs-render.ts';
const fixture = JSON.parse(readFileSync(new URL('../contracts/docs-dialect-reference.json', import.meta.url), 'utf8'));
// HTML attribute order and inter-tag whitespace are not semantic differences.
const normalize = (html: string) => html.replace(/<input([^>]+)>/g, (_, attributes: string) =>
  '<input ' + (attributes.match(/[a-z]+="[^"]*"/g) ?? []).sort().join(' ') + '>')
  .replace(/>\s+</g, '><').replace(/\s+(?=<\/?(?:ul|ol|li)>)/g, '').trim();
for (const name of ['breakless', 'indented-code', 'underscore', 'strike', 'autolink', 'table', 'headings', 'task-list', 'ordered', 'two-space-nested', 'ordered-resume', 'ordered-top-level-neighbor', 'ordered-deep', 'ordered-paragraph']) {
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

test('non-one ordered paragraph interrupt leaves fenced code unchanged', () => {
  const html = renderDocsPage('```text\nIntro\n3. literal\n```', 'https://example.test/').html;
  assert.match(html, /<code class="language-text">Intro\n3\. literal\n<\/code>/);
  assert.ok(!html.includes('<ol>'));
});

test('indented code retains numbered text without inserted blank lines or list conversion', () => {
  const html = renderDocsPage('    Intro\n    3. literal', 'https://example.test/').html;
  assert.equal(html, '<pre><code>Intro\n3. literal\n</code></pre>\n');
});

test('block precheck preserves indented code for CRLF and tab indentation', () => {
  for (const source of ['    Intro\r\n    3. literal', '\tIntro\n\t3. literal']) {
    assert.equal(renderDocsPage(source, 'https://example.test/').html,
      '<pre><code>Intro\n3. literal\n</code></pre>\n');
  }
});
