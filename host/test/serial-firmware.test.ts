import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { serialFirmware } from './helpers/serial-firmware.ts';
import { encodeFrame } from '../src/protocol/codec.ts';
test('firmware simulator rejects duplicate and out-of-order commands across sequence wrap', async () => {
  const peer = new EventEmitter() as EventEmitter & {
    write(data: Uint8Array): void;
  };
  const received: Uint8Array[] = [];
  peer.write = (data) => {
    received.push(data);
  };
  const fw = await serialFirmware({ fd: -1, peer, close: async () => {} });
  try {
    const payload = fw.dictionary.encode('queue_digital_out', {
      oid: 2,
      clock: 0,
      on_ticks: 1,
    });
    for (let i = 0; i < 36; i++) {
      const sequence = (i + 1) & 15;
      peer.emit('data', encodeFrame((sequence + 2) & 15, payload));
      assert.equal(fw.outputs.length, i);
      assert.equal(received.at(-1)![1] & 15, sequence);
      peer.emit('data', encodeFrame(sequence, payload));
      peer.emit('data', encodeFrame(sequence, payload));
      assert.equal(fw.outputs.length, i + 1);
      assert.equal(received.at(-1)![1] & 15, (sequence + 1) & 15);
    }
  } finally {
    await fw.close();
  }
});
test('timer-delayed firmware response frames use sequence at send time', async () => {
  const peer = new EventEmitter() as EventEmitter & {
    write(data: Uint8Array): void;
  };
  let receive!: (data: Uint8Array) => void;
  const response = new Promise<Uint8Array>((resolve) => {
    receive = resolve;
  });
  peer.write = (data) => {
    if (
      fw.dictionary
        .parseFrame(data)
        .some((message) => message.name === 'echo_response')
    )
      receive(data);
  };
  const fw = await serialFirmware({ fd: -1, peer, close: async () => {} });
  try {
    fw.delayEcho(1);
    peer.emit(
      'data',
      encodeFrame(1, fw.dictionary.encode('echo', { value: 73 })),
    );
    peer.emit('data', encodeFrame(2, fw.dictionary.encode('get_config', {})));
    assert.equal((await response)[1] & 15, 3);
  } finally {
    await fw.close();
  }
});
