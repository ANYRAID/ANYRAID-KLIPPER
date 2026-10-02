#!/usr/bin/env node
// GPL-3.0-or-later. Node orchestration for an explicitly selected Klippy backend.
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {loadKlippyTests, runKlippyTest} from '../host/src/diagnostics/klippy-test.ts';
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {
    dictdir: {type: 'string', short: 'd', default: '.'},
    tempdir: {type: 'string', short: 't', default: '.'},
    keepfiles: {type: 'boolean', short: 'k'}, verbose: {type: 'boolean', short: 'v'},
    python: {type: 'string', default: process.env.PYTHON ?? 'python3'},
    klippy: {type: 'string', default: fileURLToPath(new URL('../klippy/klippy.py', import.meta.url))},
    'timeout-ms': {type: 'string', default: '120000'}, help: {type: 'boolean', short: 'h'},
  }});
  if (values.help) {
    process.stdout.write('Usage: node scripts/test_klippy.ts [-d DICTDIR] [-t TEMPDIR] [-k] [-v] [--python EXECUTABLE] [--klippy ENTRYPOINT] [--timeout-ms 120000] FILE.test ...\nThe default backend still requires Python and Klippy dependencies. Each case has isolated artifacts; failures retain them.\n');
  } else {
    if (!positionals.length) throw new Error('At least one test file is required');
    if (!/^\d+$/.test(values['timeout-ms'])) throw new Error('Invalid timeout');
    const timeoutMs = Number(values['timeout-ms']);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Timeout must be 1..600000 ms');
    // Parse every file before invoking any backend.
    const tests = await Promise.all(positionals.map(async filename => ({filename,
      plans: await loadKlippyTests(filename, values.dictdir)})));
    let count = 0;
    for (const test of tests) for (const plan of test.plans) {
      process.stderr.write(`    Starting ${test.filename} (${plan.config})\n`);
      const directory = await runKlippyTest(plan, {executable: values.python, entrypoint: resolve(values.klippy),
        cwd: process.cwd(), tempdir: values.tempdir, verbose: values.verbose, keepfiles: values.keepfiles,
        timeoutMs, signal: controller.signal});
      if (values.keepfiles) process.stderr.write(`    Artifacts: ${directory}\n`);
      count++;
    }
    process.stderr.write(`\n    All ${tests.length} test files (${count} cases) passed\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
