import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchDocs, highlightDocs } from '../src/diagnostics/docs-search.ts';

test('exact title ranks above body matches even after the first fifty entries', () => {
  const entries = Array.from({ length: 80 }, (_, i) => ({ title: `Page ${i}`, url: `${i}.html`, text: 'pressure advance' }));
  entries.push({ title: 'Pressure advance', url: 'guide.html', text: 'guide' });
  assert.equal(searchDocs(entries, '  PRESSURE   advance ')[0].url, 'guide.html');
  assert.equal(searchDocs(entries, 'pressure advance').length, 50);
  assert.deepEqual(searchDocs(entries, ' '), []);
});

test('all terms must match; Unicode and punctuation remain literal', () => {
  const entries = [{ title: '运动精度', url: 'a.html', text: 'Node.js 26 校验' },
    { title: 'Else', url: 'b.html', text: 'NodeXjs' }];
  assert.equal(searchDocs(entries, '运动精度 26')[0].url, 'a.html');
  assert.equal(searchDocs(entries, 'node.js').length, 1);
  assert.deepEqual(searchDocs(entries, '运动精度 27'), []);
});

test('highlighting preserves literal text and matches overlapping terms longest first', () => {
  const text = '<img> Node.js 压力提前 😀';
  const parts = highlightDocs(text, 'Node.js 压力 压力提前 <img>');
  assert.equal(parts.map((part) => part.text).join(''), text);
  assert.deepEqual(parts.filter((part) => part.match).map((part) => part.text), ['<img>', 'Node.js', '压力提前']);
  assert.deepEqual(highlightDocs('NodeXjs', 'Node.js'), [{ text: 'NodeXjs', match: false }]);
  assert.equal(highlightDocs('a+b [x]', 'a+b [x]').filter((part) => part.match).length, 2);
});
