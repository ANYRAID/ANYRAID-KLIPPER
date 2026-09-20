import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { stackFixture, stackChain } from '../test/fixtures/stack.ts';
const root = resolve(import.meta.dirname, '../..'),
  dir = mkdtempSync(join(tmpdir(), 'stack-bench-'));
try {
  const oracle = join(dir, 'oracle.py');
  writeFileSync(
    oracle,
    execFileSync('git', ['show', '30922c02:scripts/checkstack.py'], {
      cwd: root,
    }),
  );
  const results = [];
  for (const [name, input] of Object.entries({
    mixed: stackFixture(),
    forest: stackChain(5000, 8),
  })) {
    const samples: { node: number[]; python: number[] } = {
      node: [],
      python: [],
    };
    let expected: string | undefined;
    for (const mode of ['python', 'node'] as const)
      for (let run = 0; run < 13; run++) {
        const start = performance.now(),
          result = spawnSync(
            mode === 'node' ? process.execPath : '/usr/bin/python3',
            [mode === 'node' ? join(root, 'scripts/checkstack.ts') : oracle],
            { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
          );
        const elapsed = performance.now() - start;
        assert.equal(result.status, 0, result.stderr);
        const hash = createHash('sha256').update(result.stdout).digest('hex');
        expected ??= hash;
        assert.equal(hash, expected);
        if (run >= 2) samples[mode].push(elapsed);
      }
    const stats = (v: number[]) => {
      v.sort((a, b) => a - b);
      return { medianMs: v[5], p95Ms: v[10] };
    };
    results.push({
      name,
      inputBytes: Buffer.byteLength(input),
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
        oracle: '30922c02',
        samples: 11,
        warmups: 2,
        scope:
          'Unchanged original script executed with Python 3; full CLI startup, stdin, analysis and stdout collection. Synthetic AVR disassembly, not actual firmware stack measurement.',
        results,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
