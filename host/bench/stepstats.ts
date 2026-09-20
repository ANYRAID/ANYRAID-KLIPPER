import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { stepstatsOracle } from '../test/helpers/stepstats-oracle.ts';
const dir = mkdtempSync(join(tmpdir(), 'stepstats-bench-'));
try {
  const oracle = join(dir, 'oracle.py'),
    input = join(dir, 'input');
  writeFileSync(oracle, stepstatsOracle());
  const results = [];
  for (const count of [100, 100000]) {
    const text =
      'config_stepper oid=1\n' +
      'set_next_step_dir oid=1 dir=1\nqueue_step oid=1 count=9007199254740993\n'.repeat(
        count,
      );
    writeFileSync(input, text);
    let expected: string | undefined;
    for (const [name, executable, args] of [
      ['python', '/usr/bin/python3', [oracle, input]],
      ['node', process.execPath, ['scripts/stepstats.ts', input]],
    ] as const) {
      const samples = [];
      for (let run = 0; run < 13; run++) {
        const begun = performance.now();
        const result = spawnSync(executable, [...args], {
          cwd: resolve(import.meta.dirname, '../..'),
          encoding: 'utf8',
        });
        const elapsed = performance.now() - begun;
        assert.equal(result.status, 0, result.stderr);
        expected ??= result.stdout;
        assert.equal(result.stdout, expected);
        if (run >= 2) samples.push(elapsed);
      }
      samples.sort((a, b) => a - b);
      results.push({
        name,
        records: count * 2 + 1,
        bytes: Buffer.byteLength(text),
        medianMs: samples[5],
        p95Ms: samples[10],
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        warmups: 2,
        samples: 11,
        oracle:
          '8b02250d Python 2 source with mechanical Python 3 syntax and byte adaptation',
        scope:
          'Offline CLI including process startup and file parsing; not print throughput.',
        results,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
