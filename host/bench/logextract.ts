import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { completeShutdown } from '../test/fixtures/logextract.ts';
import {
  logextractOracle,
  logextractPin,
} from '../test/fixtures/logextract-oracle.ts';
const root = resolve(import.meta.dirname, '../..'),
  dir = mkdtempSync(join(tmpdir(), 'logextract-bench-'));
const digest = (work: string) => {
  const h = createHash('sha256');
  for (const n of readdirSync(work)
    .filter((n) => n !== 'input.log')
    .sort()) {
    h.update(n);
    h.update(readFileSync(join(work, n)));
  }
  return h.digest('hex');
};
const stats = (v: number[]) => {
  v.sort((a, b) => a - b);
  return { medianMs: v[5], p95Ms: v[10] };
};
try {
  const oracle = join(dir, 'oracle.py');
  writeFileSync(oracle, logextractOracle());
  const large = completeShutdown.slice(0, 10).concat(
    ['Dumping send queue 20000 messages'],
    Array.from(
      { length: 20000 },
      (_, i) =>
        `Sent ${i} 9.100000 9.000000 10: seq: 1${(i % 16).toString(16)}, queue_step oid=1 clock=${9000000 + i}`,
    ),
    completeShutdown.slice(14),
  );
  const cases = {
    small: completeShutdown.join('\n'),
    manyShutdowns: Array.from({ length: 200 }, () =>
      completeShutdown.join('\n'),
    ).join('\n'),
    largeQueue:
      Array.from(
        { length: 200000 },
        (_, i) => `Stats ${i}.0: normal background log`,
      ).join('\n') +
      '\n' +
      large.join('\n'),
  };
  const results = [];
  for (const [name, content] of Object.entries(cases)) {
    const samples: { node: number[]; python: number[] } = {
      node: [],
      python: [],
    };
    let expected: string | undefined;
    for (const mode of ['python', 'node'] as const) {
      const work = join(dir, name + mode);
      mkdirSync(work);
      writeFileSync(join(work, 'input.log'), content);
      for (let run = 0; run < 13; run++) {
        const start = performance.now(),
          result = spawnSync(
            mode === 'node' ? process.execPath : '/usr/bin/python3',
            [
              mode === 'node' ? join(root, 'scripts/logextract.ts') : oracle,
              'input.log',
            ],
            { cwd: work, encoding: 'utf8' },
          );
        const elapsed = performance.now() - start;
        assert.equal(result.status, 0, result.stderr);
        if (run >= 2) samples[mode].push(elapsed);
        const hash = digest(work);
        if (expected === undefined) expected = hash;
        else assert.equal(hash, expected, `${name} ${mode} output`);
      }
    }
    results.push({
      name,
      bytes: Buffer.byteLength(content),
      node: stats(samples.node),
      python: stats(samples.python),
      outputSha256: expected,
    });
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        python: spawnSync('/usr/bin/python3', ['--version'], {
          encoding: 'utf8',
        }).stdout.trim(),
        oracle: logextractPin,
        samples: 11,
        warmups: 2,
        scope:
          'Separate CLI processes including startup, streaming UTF-8 reads, extraction, sorting and writes. Every output hash matches Python. Offline diagnostics only; not a print-speed measurement.',
        results,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
