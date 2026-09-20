#!/usr/bin/env -S node
// GPL-3.0-or-later. See host/src/diagnostics/stepstats.ts.
import { stepStatisticsFile } from '../host/src/diagnostics/stepstats.ts';
import { once } from 'node:events';
async function main() {
  const args = process.argv.slice(2);
  if (
    args
      .slice(0, args.includes('--') ? args.indexOf('--') : args.length)
      .some((arg) => arg === '-h' || arg === '--help')
  ) {
    process.stdout.write(
      'Usage: stepstats.ts [options] <comms file>\n\nOptions:\n  -h, --help  show this help message and exit\n',
    );
    return;
  }
  if (args[0] === '--') args.shift();
  else if (args.some((arg) => arg.startsWith('-'))) {
    process.stderr.write('stepstats: unknown option\n');
    process.exitCode = 2;
    return;
  }
  if (args.length !== 1) {
    process.stderr.write(
      'Usage: stepstats.ts [options] <comms file>\nstepstats: Incorrect number of arguments\n',
    );
    process.exitCode = 2;
    return;
  }
  const output = await stepStatisticsFile(args[0]);
  if (!process.stdout.write(output)) await once(process.stdout, 'drain');
}
main().catch((error) => {
  process.stderr.write(
    `stepstats: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
