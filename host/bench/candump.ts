import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import {
  canDictionary,
  canFixture,
  canLine,
  canFrames,
} from '../test/fixtures/candump.ts';
import { candumpOracle, candumpPin } from '../test/fixtures/candump-oracle.ts';
const dir = mkdtempSync(join(tmpdir(), 'candump-bench-')),
  root = resolve(import.meta.dirname, '../..');
try {
  candumpOracle(dir);
  writeFileSync(join(dir, 'mcu.dict'), JSON.stringify(canDictionary));
  const results = [];
  const busy = Array.from({ length: 30000 }, (_, i) => {
    const f = canFrames[i % canFrames.length],
      id = i % 2 ? '109' : '108';
    return (
      canLine(`${i}.0`, id, f.subarray(0, 8)) +
      '\n' +
      canLine(`${i}.000001`, id, f.subarray(8))
    );
  }).join('\n');
  for (const [name, content] of Object.entries({ mixed: canFixture(), busy })) {
    writeFileSync(join(dir, 'input.log'), content);
    const samples: { node: number[]; python: number[] } = {
      node: [],
      python: [],
    };
    let expected: string | undefined;
    for (const mode of ['python', 'node'] as const)
      for (let run = 0; run < 13; run++) {
        const start = performance.now(),
          r = spawnSync(
            mode === 'node' ? process.execPath : '/usr/bin/python3',
            [
              mode === 'node'
                ? join(root, 'scripts/parsecandump.ts')
                : join(dir, 'scripts/parsecandump.py'),
              'input.log',
              '108',
              'mcu.dict',
            ],
            { cwd: dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
          );
        const elapsed = performance.now() - start;
        assert.equal(r.status, 0, r.stderr);
        const hash = createHash('sha256').update(r.stdout).digest('hex');
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
      inputBytes: Buffer.byteLength(content),
      node: stats(samples.node),
      python: stats(samples.python),
      outputSha256: expected,
    });
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        oracle: candumpPin,
        samples: 11,
        warmups: 2,
        scope:
          'Complete independent CLI runs, including strict UTF-8 input, packet decoding, resync and stdout collection. Identical output hashes each run. Offline diagnostics; no live CAN or printing benchmark.',
        results,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
