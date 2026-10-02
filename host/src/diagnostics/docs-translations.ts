import { cp, mkdtemp, readdir, readFile, rm, copyFile, mkdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDocsSite } from './docs-site.ts';

export interface DocsLanguage { directory: string; language: string; name: string; searchLanguage: string }
export function parseDocsLanguages(text: string): DocsLanguage[] {
  const used = new Set(['en']);
  return text.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith('#')).map((line) => {
    const [directory, language, name, searchLanguage] = line.split(',').map((field) => field.trim());
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(directory ?? '')
      || !/^[A-Za-z][A-Za-z0-9-]*$/.test(language ?? '') || !name || !searchLanguage
      || used.has(language.toLowerCase())) throw new Error(`Invalid or duplicate translation row: ${line}`);
    used.add(language.toLowerCase());
    return { directory, language, name, searchLanguage };
  });
}

const labelKeys = ['Installation and Configuration', 'Configuration Reference', 'Bed Level',
  'Resonance Compensation', 'Command templates', 'Developer Documentation', 'Device Specific Documents'];
export function translationNavigation(text: string): { title: string; labels: Record<string, string> } {
  const lines = text.split(/\r?\n/);
  const title = lines[0]?.trim();
  const labels = Object.fromEntries(labelKeys.map((key, i) => [key, lines[(i + 1) * 2]?.trim()]));
  if (!title || Object.values(labels).some((value) => !value)) throw new Error('Incomplete translated Navigation.md');
  return { title, labels };
}

export async function buildTranslatedDocs(options: { docs: string; config: string; translations: string; output: string }) {
  const languages = parseDocsLanguages(await readFile(join(options.translations, 'active_translations'), 'utf8'));
  const temporary = await mkdtemp(join(tmpdir(), 'docs-translations-'));
  const all = [{ name: 'English', language: 'en' }, ...languages];
  const reports: { language: string; pages: number; assets: number }[] = [];
  try {
    // Stage and validate all translated inputs before producing a site.
    const staged = [];
    for (const language of languages) {
      const source = join(options.translations, 'docs/locales', language.directory);
      if (!(await lstat(source)).isDirectory() || (await lstat(source)).isSymbolicLink()) throw new Error('Invalid locale directory');
      const nav = translationNavigation(await readFile(join(source, 'Navigation.md'), 'utf8'));
      const docs = join(temporary, language.language);
      await mkdir(docs);
      const files = await readdir(source, { withFileTypes: true });
      for (const file of files) {
        if (!file.name.endsWith('.md') || file.name === 'Navigation.md') continue;
        if (!file.isFile()) throw new Error(`Invalid translated Markdown: ${file.name}`);
        await copyFile(join(source, file.name), join(docs, file.name));
      }
      if (files.some((file) => file.name === 'manual-index.md')) {
        await copyFile(join(docs, 'manual-index.md'), join(docs, 'index.md'));
        await rm(join(docs, 'manual-index.md'));
      }
      for (const resource of ['img', 'prints']) await cp(join(options.docs, resource), join(docs, resource), { recursive: true });
      staged.push({ language, nav, docs });
    }
    const output = resolve(options.output);
    const alternatives = (translated: boolean) => all.map((item) => ({ ...item,
      href: (translated ? '../' : '') + (item.language === 'en' ? '' : `${item.language}/`) + 'index.html' }));
    reports.push({ language: 'en', ...await buildDocsSite({ docs: options.docs, output,
      config: options.config, alternatives: alternatives(false) }) });
    for (const item of staged) {
      reports.push({ language: item.language.language, ...await buildDocsSite({ docs: item.docs,
        config: options.config, output: join(output, item.language.language), language: item.language.language,
        title: item.nav.title, navigationLabels: item.nav.labels, alternatives: alternatives(true) }) });
    }
    return reports;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
