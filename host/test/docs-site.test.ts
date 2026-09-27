import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDocsSite } from '../src/diagnostics/docs-site.ts';

test('builds navigable pages, search and binary assets without modifying sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docs-site-'));
  try {
    const docs = join(root, 'docs'), output = join(root, 'site'), config = join(root, 'config.yml');
    await mkdir(join(docs, 'nested'), { recursive: true });
    await writeFile(config, 'site_name: Example\nrepo_url: https://example.test/repo\nnav:\n  - index.md\n  - Guides:\n    - nested/guide.md\n');
    await writeFile(join(docs, 'index.md'), '# Welcome\n\n[Guide](nested/guide.md)\n');
    await writeFile(join(docs, 'nested/guide.md'), '# Guide\n\n## Setup\n\nDo this.');
    await writeFile(join(docs, 'README.md'), 'private build instructions');
    await writeFile(join(docs, 'asset.bin'), Buffer.from([0, 255, 13]));
    assert.deepEqual(await buildDocsSite({ docs, output, config }), { pages: 2, assets: 1 });
    const html = await readFile(join(output, 'nested/guide.html'), 'utf8');
    assert.match(html, /href="\.\.\/index.html"/);
    assert.match(html, /src="\.\.\/site.js"/);
    assert.match(html, /href="#setup"/);
    assert.match(html, /data-root="\.\.\/"/);
    assert.deepEqual(await readFile(join(output, 'asset.bin')), Buffer.from([0, 255, 13]));
    const search = JSON.parse(await readFile(join(output, 'search.json'), 'utf8'));
    assert.deepEqual(search.map((item: { url: string }) => item.url), ['index.html', 'nested/guide.html']);
    assert.match(search[1].text, /Do this/);
    await assert.rejects(buildDocsSite({ docs, output, config }), /EEXIST/);
    await assert.rejects(buildDocsSite({ docs, output: join(docs, 'output'), config }), /outside documentation/);
    await symlink(docs, join(root, 'alias'));
    await assert.rejects(buildDocsSite({ docs, output: join(root, 'alias/output'), config }), /outside documentation/);
    assert.equal(await readFile(join(docs, 'index.md'), 'utf8'), '# Welcome\n\n[Guide](nested/guide.md)\n');
    await writeFile(join(docs, 'site.js'), 'collision');
    await assert.rejects(buildDocsSite({ docs, output: join(root, 'new-site'), config }), /Output collision/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
