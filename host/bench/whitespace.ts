import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '../..'),
  dir = mkdtempSync(join(tmpdir(), 'whitespace-bench-')),
  python = process.env.WHITESPACE_PYTHON ?? 'python3';
try {
  const oracle = join(dir, 'oracle.py');
  writeFileSync(
    oracle,
    execFileSync('git', ['show', 'cd9d5c66:scripts/check_whitespace.py'], {
      cwd: root,
    }),
  );
  const files = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--',
      'config',
      'docs',
      'klippy',
      'scripts',
      'src',
      'test',
      'host/src',
      'host/test',
      'host/scripts',
      'host/bench',
    ],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(
      (f) =>
        f &&
        !f.startsWith('scripts/kconfig/') &&
        (/\.(?:c|s|h|py|sh|md|cfg|txt|html|css|yaml|yml|test|config|ts|mts|lds)$/i.test(
          f,
        ) ||
          /(?:^|\/)(?:Makefile|Kconfig)$/i.test(f)),
    )
    .map((f) => join(root, f));
  const bulk = join(dir, 'bulk.txt');
  writeFileSync(
    bulk,
    (
      'Normal source text, numbers 123456789 and punctuation.\n' +
      'UTF-8 中文 😀 café\n'
    ).repeat(50000),
  );
  const results = [];
  for (const [name, args] of [
    ['repository', files],
    ['bulk', [bulk]],
  ] as const) {
    const samples: { node: number[]; python: number[] } = {
      node: [],
      python: [],
    };
    let expected: string | undefined;
    for (const mode of ['python', 'node'] as const)
      for (let run = 0; run < 13; run++) {
        const start = performance.now(),
          r = spawnSync(
            mode === 'python' ? python : process.execPath,
            [
              mode === 'python'
                ? oracle
                : join(root, 'scripts/check_whitespace.ts'),
              ...args,
            ],
            { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
          );
        const elapsed = performance.now() - start;
        assert.equal(r.error, undefined);
        assert.equal(r.status, 0, r.stderr);
        const hash = createHash('sha256')
          .update(r.stdout)
          .update(r.stderr)
          .digest('hex');
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
      files: args.length,
      node: stats(samples.node),
      python: stats(samples.python),
      outputSha256: expected,
    });
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        python: spawnSync(python, ['--version'], {
          encoding: 'utf8',
        }).stdout.trim(),
        oracle: 'cd9d5c66',
        samples: 11,
        warmups: 2,
        scope:
          'Complete CLI startup, reads and validation. Repository uses current tracked source paths; bulk contains 100,000 ASCII/Unicode lines. Exit status and both output streams match.',
        results,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
