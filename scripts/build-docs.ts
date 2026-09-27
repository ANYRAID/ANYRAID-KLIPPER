import { resolve } from 'node:path';
import { buildDocsSite } from '../host/src/diagnostics/docs-site.ts';

const args = process.argv.slice(2);
if (args.length !== 1 || args[0].startsWith('-')) {
  console.error('Usage: node scripts/build-docs.ts NEW_OUTPUT_DIRECTORY');
  process.exitCode = 1;
} else {
  const root = resolve(import.meta.dirname, '..');
  try {
    console.log(JSON.stringify(await buildDocsSite({ docs: resolve(root, 'docs'),
      config: resolve(root, 'docs/_klipper3d/mkdocs.yml'), output: args[0] })));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
