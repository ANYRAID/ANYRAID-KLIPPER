import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
export const candumpPin = '0440b99b';
export function candumpOracle(dir: string) {
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'klippy'));
  for (const file of ['scripts/parsecandump.py', 'klippy/msgproto.py'])
    writeFileSync(
      join(dir, file),
      execFileSync('git', ['show', `${candumpPin}:${file}`], {
        cwd: resolve(import.meta.dirname, '../../..'),
      }),
    );
}
