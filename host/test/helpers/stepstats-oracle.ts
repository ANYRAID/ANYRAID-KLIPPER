import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
/** Mechanical Python 2 syntax/byte-input adaptation, no algorithm changes. */
export function stepstatsOracle(): string {
  return execFileSync('git', ['show', '8b02250d:scripts/stepstats.py'], {
    cwd: resolve(import.meta.dirname, '../../..'),
    encoding: 'utf8',
  })
    .replace(
      'parts = line.split()',
      "parts = [p.decode('latin1') for p in line.split()]",
    )
    .replace('print "oid:', 'print("oid:')
    .replace('so[4]-so[3])', 'so[4]-so[3]))');
}
