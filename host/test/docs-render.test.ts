import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { renderDocsPage, docsLink } from '../src/diagnostics/docs-render.ts';

test('page metadata, stable anchors, links and fenced examples survive rendering', () => {
  const page = renderDocsPage('---\ntitle: Welcome\nhide: [toc]\n---\n'
    + '# Café & `gcode_move`\n\n## Repeat\n\n## Repeat\n\n'
    + '[config](../config/test.cfg) [page](Config.md?q=1#part)\n\n'
    + '```text\n[x](Other.md) <tag>\n```\n', 'https://github.com/Klipper3d/klipper');
  assert.equal(page.title, 'Welcome');
  assert.equal(page.hideToc, true);
  assert.deepEqual(page.headings.map((heading) => heading.id), ['cafe-gcode_move', 'repeat', 'repeat_1']);
  assert.match(page.html, /href="Config.html\?q=1#part"/);
  assert.match(page.html, /href="https:\/\/github.com\/Klipper3d\/klipper\/blob\/master\/config\/test.cfg"/);
  assert.match(page.html, /\[x\]\(Other.md\) &lt;tag&gt;/);
  assert.ok(!page.text.includes('title: Welcome'));
});

test('external URLs and fragment-only links retain their targets', () => {
  for (const value of ['https://example.test/a.md', '//example.test/a.md', '#a.md', 'mailto:a.md']) {
    assert.equal(docsLink(value), value);
  }
  assert.equal(docsLink('folder/a.md#section'), 'folder/a.html#section');
  assert.equal(docsLink('image.svg'), 'image.svg');
});

test('metadata rejects ambiguous or invalid structure', () => {
  for (const input of ['title: [a]', 'hide: toc', '- item', 'title: a\ntitle: b']) {
    assert.throws(() => renderDocsPage(`---\n${input}\n---\n# Page`, 'https://example.test/'));
  }
});

test('image attributes, explicit heading IDs and tables render as site content', () => {
  const page = renderDocsPage('# Title {#custom}\n\n![](img/logo.png){ .center-image }\n\n'
    + '| A | B |\n| --- | --- |\n| 1 | 2 |\n', 'https://example.test/');
  assert.equal(page.headings[0].id, 'custom');
  assert.match(page.html, /class="center-image"/);
  assert.match(page.html, /<table>/);
  assert.ok(!page.html.includes('{ .center-image }'));
});

test('all frozen documentation pages render with unique heading IDs', () => {
  const fixture = JSON.parse(gunzipSync(readFileSync(
    new URL('../contracts/docs-markdown-reference.json.gz', import.meta.url))).toString());
  let count = 0;
  for (const item of fixture.cases) {
    if (!item.name.startsWith('docs/')) continue;
    const result = renderDocsPage(item.input, item.repoUrl);
    assert.ok(result.html.length, item.name);
    assert.equal(new Set(result.headings.map((heading) => heading.id)).size, result.headings.length, item.name);
    count++;
  }
  assert.equal(count, 58);
});
