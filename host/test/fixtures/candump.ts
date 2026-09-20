import { encodeFrame, encodeInteger } from '../../src/protocol/codec.ts';
export const canDictionary = {
  commands: {
    'queue_step oid=%c interval=%u count=%hu add=%hi': -32,
    'set_pin pin=%u value=%c': 2,
  },
  responses: { 'buffer data=%*s': 3, 'status clock=%u': 4 },
  output: { 'debug value=%u buffer=%.*s': 5 },
  enumerations: { pin: { PA0: [10, 4] } },
  config: {},
};
const frame = (seq: number, data: number[]) =>
  encodeFrame(seq, Uint8Array.from(data));
export const canFrames = [
  frame(0, []),
  frame(
    1,
    [-32, 1, 4294967295, 20, -50].flatMap((v) => encodeInteger(v)),
  ),
  frame(2, [2, 10, 1]),
  frame(3, [2, 99, 0]),
  frame(4, [3, 8, 0, 255, 39, 34, 92, 9, 10, 13]),
  frame(5, [4, ...encodeInteger(0xffffffff), 3, 1, 39]),
  frame(6, [5, 95, 3, 0, 255, 126]),
  frame(7, [95, 1, 2]),
  frame(8, [1, 0, 40]),
];
export const canLine = (time: string, id: string, bytes: Uint8Array) =>
  `(${time}) can0  TX - - ${id} [${bytes.length}] ${[...bytes].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`;
export function canFixture() {
  const lines = ['', 'not a record', '(1.0) can0 TX - - 108 bad 00'];
  let tick = 0;
  for (const frame of canFrames)
    for (let split = 0; split <= frame.length; split++) {
      lines.push(canLine(String(++tick) + '.0', '108', frame.slice(0, split)));
      lines.push(canLine(String(++tick) + '.0', '108', frame.slice(split)));
    }
  lines.push(
    canLine('0.0078125', '109', Uint8Array.from([0, 1, 2, 3, 4])),
    canLine('-0.0', '109', Uint8Array.from([4, 5, 126, ...canFrames[0]])),
    canLine('-2.0', '200', new Uint8Array()),
    '  ',
    canLine('nan', '108', canFrames[0]),
    canLine('inf', '108', canFrames[0]),
  );
  const bad = canFrames[1].slice();
  bad[bad.length - 2] ^= 1;
  lines.push(
    canLine('2000.0', '108', bad),
    canLine('2001.0', '108', canFrames[0]),
  );
  lines.push(
    canLine('2002.0', '108', canFrames[1].slice(0, 4)),
    canLine('2003.0', '109', canFrames[4].slice(0, 4)),
    canLine('2004.0', '108', canFrames[1].slice(4)),
    canLine('2005.0', '109', canFrames[4].slice(4)),
  );
  return lines.join('\n');
}
