import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeFrame } from '../src/protocol/codec.ts';
import { utf8LineBatches } from '../src/diagnostics/utf8-lines.ts';
import { CandumpScanner, bytesRepr } from '../src/diagnostics/candump.ts';
import {
  canDictionary,
  canFixture,
  canLine,
  canFrames,
} from './fixtures/candump.ts';
const root = resolve(import.meta.dirname, '../..');
import { candumpOracle } from './fixtures/candump-oracle.ts';
test('CAN CLI matches historical Python across packet boundaries, resync, timestamps and dictionary formats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'candump-test-'));
  try {
    candumpOracle(dir);
    writeFileSync(join(dir, 'mcu.dict'), JSON.stringify(canDictionary));
    for (const newline of ['\n', '\r\n', '\r']) {
      writeFileSync(
        join(dir, 'input.log'),
        canFixture().replaceAll('\n', newline),
      );
      const python = spawnSync(
          '/usr/bin/python3',
          [
            join(dir, 'scripts/parsecandump.py'),
            'input.log',
            '109',
            'mcu.dict',
          ],
          { cwd: dir, encoding: 'utf8' },
        ),
        node = spawnSync(
          process.execPath,
          [
            join(root, 'scripts/parsecandump.ts'),
            'input.log',
            '109',
            'mcu.dict',
          ],
          { cwd: dir, encoding: 'utf8' },
        );
      assert.equal(python.status, 0, python.stderr);
      assert.equal(node.status, 0, node.stderr);
      assert.equal(node.stdout, python.stdout);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('Python byte repr is identical for all byte values and quote choices', () => {
  const values = [
    new Uint8Array(256).map((_, i) => i),
    Uint8Array.from([39]),
    Uint8Array.from([34]),
    Uint8Array.from([39, 34]),
    new Uint8Array(),
  ];
  const p = spawnSync(
    '/usr/bin/python3',
    [
      '-c',
      'import json,sys;print(json.dumps([repr(bytes(v)) for v in json.load(sys.stdin)]))',
    ],
    { input: JSON.stringify(values.map((v) => [...v])), encoding: 'utf8' },
  );
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(values.map(bytesRepr), JSON.parse(p.stdout));
});
test('malformed bytes, timestamps and frame payloads are rejected without guessing or transmission', () => {
  const scanner = new CandumpScanner(
    0x108n,
    Buffer.from(JSON.stringify(canDictionary)),
    () => {},
  );
  for (const line of [
    '(oops) can0 TX - - 108 [1] 00',
    '(1) can0 TX - - 108 [1] 100',
    '(1) can0 TX - - 108 [1] xyz',
  ])
    assert.throws(() => scanner.line(line));
  assert.throws(
    () =>
      scanner.line(
        canLine('1', '108', encodeFrame(0, Uint8Array.from([3, 5, 0]))),
      ),
    /Truncated string/,
  );
  const output: string[] = [];
  const fresh = new CandumpScanner(
    0x108n,
    Buffer.from(JSON.stringify(canDictionary)),
    (l) => output.push(l),
  );
  fresh.line(canLine('0', '108', canFrames[0]));
  assert.equal(output[0], '0001:000.000000:TX Ack 10\n');
});

test('stream reader preserves multibyte UTF-8, BOM and CRLF across read boundaries, rejecting invalid bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'can-lines-'));
  try {
    const file = join(dir, 'input'),
      content = 'x'.repeat(65535) + '\r\n温度\rnext\n\ufefflast';
    writeFileSync(file, content);
    const lines: string[] = [];
    for await (const batch of utf8LineBatches(file)) lines.push(...batch);
    assert.deepEqual(lines, ['x'.repeat(65535), '温度', 'next', '\ufefflast']);
    const splitCharacter = 'x'.repeat(65535) + '温度';
    writeFileSync(file, splitCharacter + '\n');
    const decoded: string[] = [];
    for await (const batch of utf8LineBatches(file)) decoded.push(...batch);
    assert.deepEqual(decoded, [splitCharacter]);
    writeFileSync(file, Uint8Array.from([0xff]));
    await assert.rejects(async () => {
      for await (const _ of utf8LineBatches(file)) {
      }
    }, /encoded data/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
