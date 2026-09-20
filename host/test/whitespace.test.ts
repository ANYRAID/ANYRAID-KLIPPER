import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { controlCodePoint } from '../src/diagnostics/whitespace.ts';
const root = resolve(import.meta.dirname, '../..'),
  python = process.env.WHITESPACE_PYTHON ?? 'python3';
test('pinned Unicode 15 control classification matches Python 3.12 for every code point', () => {
  const result = spawnSync(
    python,
    [
      '-c',
      "import unicodedata,hashlib,json;print(json.dumps([unicodedata.unidata_version,hashlib.sha256(bytes(unicodedata.category(chr(i)).startswith('C') for i in range(0x110000))).hexdigest()]))",
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const [version, digest] = JSON.parse(result.stdout);
  assert.equal(
    version,
    '15.0.0',
    'Set WHITESPACE_PYTHON to Python 3.12 for the pinned Unicode oracle',
  );
  const values = Uint8Array.from({ length: 0x110000 }, (_, i) =>
    Number(controlCodePoint(i)),
  );
  assert.equal(createHash('sha256').update(values).digest('hex'), digest);
});
test('whitespace CLI preserves Python diagnostics, ordering and status including invalid UTF-8 and filenames with spaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whitespace-test-'));
  try {
    const oracle = join(dir, 'oracle.py');
    writeFileSync(
      oracle,
      execFileSync('git', ['show', 'cd9d5c66:scripts/check_whitespace.py'], {
        cwd: root,
      }),
    );
    const fixtures: Record<string, string | Uint8Array> = {
      'empty.c': '',
      'clean.c': 'int main(void);\n',
      'spaces name.py': 'x '.repeat(41) + '\t\n\n',
      Makefile: '\techo okay\n',
      MAKEFILE: '\techo okay\t\n',
      'code.C': 'x'.repeat(90) + '\n',
      'unicode.py': '温'.repeat(81) + '\n',
      'supplementary.py': '😀'.repeat(80) + '\n',
      'bad.txt': Uint8Array.from([0xff, 10, 32, 10, 13, 10, 0xe2, 0x82]),
      'controls.txt': '\ufeffx\n\u0000\t\n\r\n\u0378\n\ue000\n\u{10ffff}\n',
      'last.txt': 'missing newline',
      'ts.ts': 'x'.repeat(100) + '\n',
    };
    for (const [name, data] of Object.entries(fixtures))
      writeFileSync(join(dir, name), data);
    for (const names of [
      Object.keys(fixtures),
      ['empty.c', 'clean.c', 'Makefile'],
      ['missing-file'],
      [],
    ]) {
      const args = names.map((n) => join(dir, n)),
        p = spawnSync(python, [oracle, ...args], { encoding: 'utf8' }),
        n = spawnSync(
          process.execPath,
          [join(root, 'scripts/check_whitespace.ts'), ...args],
          { encoding: 'utf8' },
        );
      assert.equal(n.status, p.status);
      assert.equal(n.stdout, p.stdout);
      assert.equal(n.stderr, p.stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shell entry scans Node sources and preserves spaced paths while pruning Kconfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whitespace-shell-'));
  try {
    for (const path of [
      'config',
      'docs',
      'klippy',
      'scripts/kconfig',
      'src',
      'test',
      'host/src/diagnostics',
      'host/test',
      'host/scripts',
      'host/bench',
    ])
      mkdirSync(join(dir, path), { recursive: true });
    for (const path of [
      'scripts/check_whitespace.sh',
      'scripts/check_whitespace.ts',
      'scripts/package.json',
      'host/src/diagnostics/whitespace.ts',
      'host/src/diagnostics/unicode-control-ranges.ts',
    ])
      copyFileSync(join(root, path), join(dir, path));
    writeFileSync(join(dir, 'host/package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'scripts/kconfig/ignored.py'), '\t');
    const target = join(dir, 'host/src/two words.ts');
    writeFileSync(target, 'trailing space \n');
    const run = () =>
      spawnSync('/bin/bash', [join(dir, 'scripts/check_whitespace.sh')], {
        encoding: 'utf8',
        env: { ...process.env, NODE: process.execPath },
      });
    const bad = run();
    assert.notEqual(bad.status, 0);
    assert.match(
      bad.stderr,
      /host\/src\/two words.ts:1: Line has trailing spaces/,
    );
    assert.doesNotMatch(bad.stderr, /ignored.py/);
    writeFileSync(target, 'clean\n');
    const clean = run();
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
