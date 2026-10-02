import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { analyzeStack } from '../src/diagnostics/stack.ts';
import { stackFixture, stackChain, instruction } from './fixtures/stack.ts';
const root = resolve(import.meta.dirname, '../..');
test('stack analysis matches unchanged historical Python source for calls, commands, events, cycles and policies', () => {
  const source = execFileSync(
    'git',
    ['show', '30922c02:scripts/checkstack.py'],
    { cwd: root, encoding: 'utf8' },
  );
  const samples = [
    '',
    stackFixture(),
    stackChain(200),
    stackFixture().replace('00000010', '2000000000000010'),
    [
      '2000000000000000 <a>:',
      instruction('1', 'push', 'r1'),
      instruction('2', 'call', '0x2000000000000001', '0x2000000000000001 <b>'),
      '2000000000000001 <b>:',
      instruction('3', 'push', 'r1'),
      instruction('4', 'push', 'r2'),
      instruction('5', 'ret'),
    ].join('\n'),
    [
      '10 <a>:',
      instruction('10', 'push', 'r1'),
      instruction('12', 'call', '0x20', '0x20 <b>'),
      '20 <b>:',
      instruction('20', 'push', 'r1'),
      instruction('22', 'call', '0x10', '0x10 <a>'),
    ].join('\n'),
    [
      '10 <recursive>:',
      instruction('10', 'push', 'r1'),
      instruction('12', 'call', '0x10', '0x10 <recursive>'),
    ].join('\n'),
  ];
  for (const input of samples)
    for (const policy of [
      {},
      { ignore: ['worker'] },
      { stackHop: ['worker'] },
    ]) {
      const p = spawnSync(
        '/usr/bin/python3',
        [
          '-c',
          "import sys,json,io;s=json.load(sys.stdin);ns={'__name__':'oracle'};exec(s['source'],ns);ns['IGNORE']=s['policy'].get('ignore',[]);ns['STACKHOP']=s['policy'].get('stackHop',[]);sys.stdin=io.StringIO(s['input']);ns['main']()",
        ],
        {
          input: JSON.stringify({ source, input, policy }),
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      assert.equal(p.status, 0, p.stderr);
      assert.equal(analyzeStack(input, policy), p.stdout);
    }
  const cli = spawnSync(
    process.execPath,
    [resolve(root, 'scripts/checkstack.ts')],
    { input: stackFixture().replaceAll('\n', '\r\n'), encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, analyzeStack(stackFixture()));
});
test('deep acyclic stack graph avoids language recursion and preserves exact estimates', () => {
  const n = 5000,
    output = analyzeStack(stackChain(n));
  assert.match(output, new RegExp(`f0\\[1,${3 * (n - 1) + 1}\\]:`));
  assert.equal((output.match(/^f\d+\[/gm) ?? []).length, n);
});
