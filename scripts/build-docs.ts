import { resolve } from 'node:path';
import { buildTranslatedDocs } from '../host/src/diagnostics/docs-translations.ts';
import { buildDocsSite } from '../host/src/diagnostics/docs-site.ts';

const args = process.argv.slice(2);
if (![1, 2].includes(args.length) || args.some((arg) => arg.startsWith('-'))) {
  console.error('Usage: node scripts/build-docs.ts NEW_OUTPUT_DIRECTORY [TRANSLATIONS_DIRECTORY]');
  process.exitCode = 1;
} else {
  const root = resolve(import.meta.dirname, '..');
  try {
    const options = { docs: resolve(root, 'docs'),
      config: resolve(root, 'docs/_klipper3d/mkdocs.yml'), output: args[0] };
    console.log(JSON.stringify(args[1] ? await buildTranslatedDocs({ ...options, translations: args[1] })
      : await buildDocsSite(options)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
