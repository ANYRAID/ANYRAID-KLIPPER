import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  LogExtractor,
  TMCUartHelper,
  addHighBits,
} from '../src/diagnostics/logextract.ts';
import { parseLiteral, fixed6 } from '../src/diagnostics/python-literal.ts';
import { logFixtures } from './fixtures/logextract.ts';
import { logextractOracle } from './fixtures/logextract-oracle.ts';
const root = resolve(import.meta.dirname, '../..');
test('Node log extraction CLI matches original Python output across configs, all shutdown streams and large clocks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logextract-test-'));
  try {
    const oracle = join(dir, 'oracle.py');
    writeFileSync(oracle, logextractOracle());
    for (let i = 0; i < logFixtures.length; i++) {
      const results: Record<string, string>[] = [];
      for (const mode of ['python', 'node']) {
        const work = join(dir, mode + i);
        mkdirSync(work);
        writeFileSync(join(work, 'input.log'), logFixtures[i]);
        const result = spawnSync(
          mode === 'python' ? '/usr/bin/python3' : process.execPath,
          [
            mode === 'python' ? oracle : join(root, 'scripts/logextract.ts'),
            'input.log',
          ],
          { cwd: work, encoding: 'utf8' },
        );
        assert.equal(result.status, 0, result.stderr);
        results.push(
          Object.fromEntries(
            readdirSync(work)
              .filter((n) => n !== 'input.log')
              .map((n) => [n, readFileSync(join(work, n), 'utf8')]),
          ),
        );
      }
      assert.deepEqual(results[1], results[0], `fixture ${i}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('fixed decimal formatting and log literal decoding preserve Python integer and binary64 behavior', () => {
  const values = [
    0,
    -0,
    1 / 128,
    -1 / 128,
    3 / 128,
    -3 / 128,
    1e21,
    1e30,
    1.2345675,
    -1e-10,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
  ];
  let seed = 42;
  for (let i = 0; i < 5000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    values.push((seed / 2 ** 32 - 0.5) * 2 ** ((i % 100) - 50));
  }
  const result = spawnSync(
    '/usr/bin/python3',
    [
      '-c',
      "import sys,json;print(json.dumps(['%.6f'%v for v in json.load(sys.stdin)]))",
    ],
    { input: JSON.stringify(values), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const expected = JSON.parse(result.stdout);
  expected[1] = '-0.000000';
  assert.deepEqual(values.map(fixed6), expected);
  assert.equal(parseLiteral('9007199254740993'), 9007199254740993n);
  assert.deepEqual(
    parseLiteral("b'\\x00\\377\\n'"),
    Uint8Array.from([0, 255, 10]),
  );
  assert.equal(parseLiteral("'温度\\n\\u2603'"), '温度\n☃');
  assert.deepEqual(parseLiteral('[True, False, None, 1.5, -2]'), [
    true,
    false,
    null,
    1.5,
    -2n,
  ]);
  assert.throws(() => parseLiteral("__import__('os').system('true')"));
  assert.throws(() => parseLiteral("'x' trailing"));
  assert.equal(addHighBits(0n, 0xffffffffn, 0xffffffffn), 0x100000000n);
});
test('TMC serial decoding verifies all framing bits and CRC for unsigned register values', () => {
  const helper = new TMCUartHelper();
  for (const addr of [0, 1, 255])
    for (const reg of [0, 1, 127, 128, 255])
      for (const value of [undefined, 0, 0x80000000, 0xffffffff]) {
        const data = helper.encode(
          value !== undefined && addr === 255 ? 5 : 245,
          addr,
          reg,
          value,
        );
        assert.equal(helper.parse(data), helper.pretty(addr, reg, value));
        for (let i = 0; i < data.length; i++) {
          const changed = data.slice();
          changed[i] ^= 1;
          assert.match(helper.parse(changed), /^Invalid:/);
        }
      }
  assert.equal(helper.parse(new Uint8Array()), '');
  assert.equal(helper.parse(new Uint8Array(1)), '(length?)');
});
test('extractor finish is idempotent and refuses data after finalization', () => {
  const output = new Map(),
    extractor = new LogExtractor('x', (name, data) => output.set(name, data));
  extractor.line('===== Config file =====');
  extractor.line('[mcu]');
  extractor.finish();
  extractor.finish();
  assert.equal(output.size, 1);
  assert.throws(() => extractor.line('extra'));
});

test('TMC UART outputs match the historical Python decoder for valid and damaged frames', () => {
  const helper = new TMCUartHelper(),
    frames: Uint8Array[] = [];
  for (const addr of [0, 1, 255])
    for (const reg of [0, 127, 128, 255])
      for (const value of [undefined, 0, 0x80000000, 0xffffffff]) {
        const frame = helper.encode(
          value !== undefined && addr === 255 ? 5 : 245,
          addr,
          reg,
          value,
        );
        frames.push(frame);
        for (let bit = 0; bit < frame.length * 8; bit++) {
          const changed = frame.slice();
          changed[bit >> 3] ^= 1 << (bit & 7);
          frames.push(changed);
        }
      }
  const source = logextractOracle();
  const result = spawnSync(
    '/usr/bin/python3',
    [
      '-c',
      "import sys,json; s=json.load(sys.stdin); ns={'__name__':'oracle'};exec(s['source'],ns);h=ns['TMCUartHelper']();print(json.dumps([h.parse_msg(x) for x in s['frames']]))",
    ],
    {
      input: JSON.stringify({ source, frames: frames.map((f) => [...f]) }),
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    frames.map((f) => helper.parse(f)),
    JSON.parse(result.stdout),
  );
});
