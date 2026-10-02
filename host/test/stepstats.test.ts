import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { stepstatsOracle } from './helpers/stepstats-oracle.ts';
const root = resolve(import.meta.dirname, '../..');
test('step statistics match pinned Python algorithm, including large signed counts and malformed logs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stepstats-test-'));
  try {
    const oracle = join(dir, 'oracle.py'),
      input = join(dir, 'input');
    writeFileSync(oracle, stepstatsOracle());
    const fixtures = [
      '',
      '\n\t\n',
      'config_stepper oid=1\n',
      'config_stepper oid=2\nset_next_step_dir oid=2 dir=1\nqueue_step oid=2 count=9007199254740993\nset_next_step_dir oid=2 dir=0\nqueue_step oid=2 count=-123\n',
      'config_stepper oid=100000000000000000000\nconfig_stepper oid=-2\nconfig_stepper oid=10\n',
      'config_stepper oid=2\nset_next_step_dir oid=2 dir=1\nqueue_step oid=2 count=3 count=4\nconfig_stepper oid=2\n',
      'config_stepper oid=2\r\nset_next_step_dir oid=2 dir=0\r\nqueue_step oid=2 count=+42',
      'unknown name=a=b\n',
      'unknown name=a\u00a0b\n',
      'config_stepper oid=01\nset_next_step_dir oid=01 dir=1\nqueue_step oid=01 count=5\nconfig_stepper oid=1\nset_next_step_dir oid=1 dir=1\nqueue_step oid=1 count=3\n',
      'unknown malformed\n',
      'queue_step oid=1 count=2\n',
      'config_stepper oid=1\nqueue_step oid=1 count=2\n',
      'config_stepper oid=x\n',
      'config_stepper\n',
      'config_stepper oid=1\nset_next_step_dir oid=1 dir=2\nqueue_step oid=1 count=3\n',
    ];
    let random = 17;
    let large = '';
    for (let oid = 0; oid < 20; oid++) large += `config_stepper oid=${oid}\n`;
    for (let i = 0; i < 3000; i++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const oid = random % 20;
      large += `set_next_step_dir oid=${oid} dir=${random % 2}\nqueue_step oid=${oid} count=${BigInt(random) * 9007199254740993n}\n`;
    }
    fixtures.push(large);
    for (const fixture of fixtures) {
      writeFileSync(input, Buffer.from(fixture, 'latin1'));
      const py = spawnSync('/usr/bin/python3', [oracle, input], {
        encoding: 'utf8',
      });
      const ts = spawnSync(process.execPath, ['scripts/stepstats.ts', input], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(ts.status, py.status, fixture.slice(0, 100));
      assert.equal(ts.stdout, py.stdout);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('step statistics CLI validates arguments and opens opaque byte logs without UTF-8 conversion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stepstats-cli-'));
  const cli = resolve(root, 'scripts/stepstats.ts');
  try {
    writeFileSync(
      join(dir, '--help'),
      Buffer.from('unknown field=\xff\nconfig_stepper oid=7\n', 'latin1'),
    );
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], {
        cwd: dir,
        encoding: 'utf8',
      });
    assert.equal(run().status, 2);
    assert.equal(run('--bad').status, 2);
    assert.equal(run('--help').status, 0);
    assert.equal(run('missing').status, 1);
    const result = run('--', '--help');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /oid:  7/);
    assert.equal(run('a', 'b').status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
