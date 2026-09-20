import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Historical source is an oracle only, never a runtime dependency.
export const logextractPin = 'c24fb2ea';
export function logextractOracle(): string {
  return execFileSync(
    'git',
    ['show', `${logextractPin}:scripts/logextract.py`],
    {
      cwd: resolve(import.meta.dirname, '../../..'),
      encoding: 'utf8',
    },
  );
}
