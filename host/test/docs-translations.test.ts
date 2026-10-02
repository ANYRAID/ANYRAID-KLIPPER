import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildTranslatedDocs, parseDocsLanguages, translationNavigation } from '../src/diagnostics/docs-translations.ts';

test('translation manifest accepts existing comments and rejects traversal or duplicate language output', () => {
  assert.equal(parseDocsLanguages('#header\nzh_Hans,zh,简体中文,ja,comment\n')[0].language, 'zh');
  for (const input of ['../xx,xx,X,en', 'a,../a,X,en', 'a,en,X,en', 'a,de,D,de\nb,DE,D,de']) {
    assert.throws(() => parseDocsLanguages(input));
  }
  assert.throws(() => translationNavigation('Title\n\nIncomplete'));
});

test('multilingual build preserves manual index, navigation, language switching and isolated search', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docs-languages-'));
  try {
    const docs = join(root, 'docs'), translations = join(root, 'translations');
    const locale = join(translations, 'docs/locales/zh_Hans');
    await mkdir(locale, { recursive: true });
    await mkdir(join(docs, 'img'), { recursive: true });
    await mkdir(join(docs, 'prints'));
    await writeFile(join(docs, 'index.md'), '# English home');
    await writeFile(join(docs, 'guide.md'), '# English guide');
    await writeFile(join(docs, 'img/logo.svg'), '<svg/>');
    await writeFile(join(translations, 'active_translations'), 'zh_Hans,zh,简体中文,ja,\n');
    await writeFile(join(locale, 'Navigation.md'), ['中文站点', '安装和配置', '配置参考', '调平', '共振', '命令', '开发', '设备'].join('\n\n'));
    await writeFile(join(locale, 'index.md'), '# 自动首页');
    await writeFile(join(locale, 'manual-index.md'), '# 手工首页');
    await writeFile(join(locale, 'guide.md'), '# 中文指南\n\n[首页](index.md)');
    const config = join(root, 'config.yml');
    await writeFile(config, 'site_name: English\nrepo_url: https://example.test/repo\nnav:\n  - index.md\n  - Installation and Configuration:\n    - guide.md\n');
    const output = join(root, 'site');
    const reports = await buildTranslatedDocs({ docs, translations, config, output });
    assert.deepEqual(reports.map((report) => [report.language, report.pages]), [['en', 2], ['zh', 2]]);
    const html = await readFile(join(output, 'zh/index.html'), 'utf8');
    assert.match(html, /lang="zh"/);
    assert.match(html, /手工首页/);
    assert.match(html, /安装和配置/);
    assert.match(html, /<button>搜索<\/button>/);
    assert.match(html, /跳至正文/);
    assert.match(await readFile(join(output, 'zh/site.js'), 'utf8'), /搜索结果/);
    assert.match(html, /hreflang="en" href="\.\.\/index.html"/);
    assert.match(await readFile(join(output, 'index.html'), 'utf8'), /hreflang="zh" href="zh\/index.html"/);
    const search = await readFile(join(output, 'zh/search.json'), 'utf8');
    assert.ok(search.includes('中文指南') && !search.includes('English guide'));
    assert.equal(await readFile(join(output, 'zh/img/logo.svg'), 'utf8'), '<svg/>');
    assert.equal(await readFile(join(locale, 'index.md'), 'utf8'), '# 自动首页');
  } finally { await rm(root, { recursive: true, force: true }); }
});
