import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { serialFirmware } from './helpers/serial-firmware.ts';
import { encodeFrame, FrameDecoder } from '../src/protocol/codec.ts';
test('late wire model sees only accepted commands and updates positions before a same-frame query', async () => {
  const peer = new EventEmitter() as EventEmitter & {write(data: Uint8Array): void};
  const replies: Uint8Array[] = [];
  peer.write = data => {replies.push(data);};
  const fw = await serialFirmware({fd: -1, peer, close: async () => {}}, {triggerSync: true});
  const send = (sequence: number, name: string, parameters: Parameters<typeof fw.dictionary.encode>[1]) =>
    peer.emit('data', encodeFrame(sequence, fw.dictionary.encode(name, parameters)));
  // An established connection already consumed sequences 1, 2 and 3.
  for (let sequence = 1; sequence <= 3; sequence++) send(sequence, 'get_clock', {});
  const accepted: string[] = [];
  let direction = 1, position = 0;
  const detach = fw.observeCommands(command => {
    accepted.push(command.name);
    if (command.name === 'set_next_step_dir') direction = Number(command.parameters.dir) ? 1 : -1;
    if (command.name === 'queue_step') {
      position += direction * Number(command.parameters.count);
      fw.setStepperPosition(0, position);
    }
  });
  // The old second decoder can act on a rejected stale frame, then miss the
  // actual next frame. Keep this counterexample independent of the new API.
  const decoder = new FrameDecoder();
  let oldSequence = 1, staleMotion = 0;
  const oldObserver = (chunk: Uint8Array) => {
    for (const frame of decoder.push(chunk)) {
      if ((frame[1] & 15) !== oldSequence) continue;
      oldSequence = (oldSequence + 1) & 15;
      staleMotion += fw.dictionary.parseFrame(frame).filter(c => c.name === 'queue_step').length;
    }
  };
  peer.on('data', oldObserver);
  try {
    assert.deepEqual(accepted, []); // No history replay on attachment.
    send(1, 'queue_step', {oid: 0, interval: 1000, count: 99, add: 0});
    assert.equal(staleMotion, 1);
    assert.equal(fw.motion.length, 0);
    assert.equal(position, 0);
    const frame = encodeFrame(4, Buffer.concat([
      fw.dictionary.encode('set_next_step_dir', {oid: 0, dir: 0}),
      fw.dictionary.encode('queue_step', {oid: 0, interval: 1000, count: 2, add: 0}),
      fw.dictionary.encode('stepper_get_position', {oid: 0}),
    ]));
    peer.emit('data', frame);
    assert.equal(staleMotion, 1); // The old observer missed accepted motion.
    assert.deepEqual(accepted, ['set_next_step_dir', 'queue_step', 'stepper_get_position']);
    assert.equal(position, -2);
    assert.equal(replies.flatMap(r => fw.dictionary.parseFrame(r)).findLast(c => c.name === 'stepper_position')!.parameters.pos, -2);
    peer.emit('data', frame); // Retransmission cannot move the model twice.
    assert.equal(accepted.length, 3);
    assert.equal(position, -2);
    for (let i = 0; i < 36; i++) {
      const sequence = (i + 5) & 15;
      send((sequence + 2) & 15, 'queue_step', {oid: 0, interval: 1000, count: 99, add: 0});
      send(sequence, 'queue_step', {oid: 0, interval: 1000, count: 1, add: 0});
      send(sequence, 'queue_step', {oid: 0, interval: 1000, count: 1, add: 0});
      assert.equal(position, -3 - i);
    }
    const before = accepted.length;
    detach(); detach();
    send(9, 'queue_step', {oid: 0, interval: 1000, count: 1, add: 0});
    assert.equal(fw.motion.filter(c => c.name === 'queue_step').length, 38);
    assert.equal(accepted.length, before);
    assert.equal(position, -38);
  } finally {peer.off('data', oldObserver);detach();await fw.close();}
});
test('accepted command observers exclude ignored and shutdown-rejected commands and are cleared on close', async () => {
  const peer = new EventEmitter() as EventEmitter & {write(data: Uint8Array): void};
  peer.write = () => {};
  const fw = await serialFirmware({fd: -1, peer, close: async () => {}}, {reset: 'ack'});
  const observed: string[] = [];
  fw.observeCommands(command => {observed.push(command.name);});
  let sequence = 1;
  const send = (name: string, parameters: Parameters<typeof fw.dictionary.encode>[1] = {}) =>
    peer.emit('data', encodeFrame(sequence++ & 15, fw.dictionary.encode(name, parameters)));
  try {
    fw.ignore('echo');send('echo', {value: 1});assert.deepEqual(observed, []);
    fw.emit('shutdown', {clock: 1, static_string_id: 'Timer too close'});
    send('queue_step', {oid: 0, interval: 1000, count: 1, add: 0});
    assert.deepEqual(observed, []);
    send('get_clock');send('reset');
    send('queue_step', {oid: 0, interval: 1000, count: 1, add: 0});
    assert.deepEqual(observed, ['get_clock', 'reset', 'queue_step']);
    await fw.close();send('get_clock');
    assert.deepEqual(observed, ['get_clock', 'reset', 'queue_step']);
  } finally {await fw.close();}
});
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
test('firmware clock replies wrap low bits and preserve uptime across multiple rollovers', async () => {
  const peer = new EventEmitter() as EventEmitter & {write(data: Uint8Array): void};
  const received: Uint8Array[] = [];
  peer.write = data => {received.push(data);};
  let now = 100;
  const fw = await serialFirmware({fd: -1, peer, close: async () => {}}, {now: () => now});
  let sequence = 1;
  const query = (command: string) => {
    received.length = 0;
    peer.emit('data', encodeFrame(sequence++ & 15, fw.dictionary.encode(command, {})));
    return {...received.flatMap(frame => fw.dictionary.parseFrame(frame)).find(message => message.name === (command === 'get_clock' ? 'clock' : 'uptime'))!.parameters};
  };
  try {
    for (const ticks of [1_000_000, 0xffffffff - 1, 0xffffffff, 0x100000000, 0x100000001, 5 * 0x100000000 + 123]) {
      now = 100 + (ticks - 1_000_000) / 1e6;
      assert.equal(fw.currentClock(), ticks);
      assert.deepEqual(query('get_clock'), {clock: ticks >>> 0});
      assert.deepEqual(query('get_uptime'), {high: Math.floor(ticks / 0x100000000), clock: ticks >>> 0});
    }
  } finally {await fw.close();}
});
test('shutdown stays latched in config replies, refuses outputs and is cleared only by an explicit reset',async()=>{
 const peer=new EventEmitter() as EventEmitter&{write(data:Uint8Array):void},received:Uint8Array[]=[];peer.write=data=>{received.push(data);};const fw=await serialFirmware({fd:-1,peer,close:async()=>{}},{reset:'ack'});let sequence=1;
 const send=(name:string,params:Parameters<typeof fw.dictionary.encode>[1]={})=>{received.length=0;peer.emit('data',encodeFrame(sequence++&15,fw.dictionary.encode(name,params)));return received.flatMap(frame=>fw.dictionary.parseFrame(frame));};
 try{
  send('allocate_oids',{count:1});send('finalize_config',{crc:123});assert.deepEqual(fw.configuration,{configured:true,crc:123,shutdown:false});fw.emit('shutdown',{clock:42,static_string_id:'Timer too close'});
  for(let i=0;i<3;i++)assert.deepEqual({...send('get_config').find(m=>m.name==='config')!.parameters},{is_config:1,crc:123,is_shutdown:1,move_count:512});
  const traffic=fw.configurationTraffic;assert.equal(send('queue_step',{oid:0,interval:1000,count:1,add:0})[0].name,'is_shutdown');assert.equal(send('allocate_oids',{count:2})[0].name,'is_shutdown');assert.equal(fw.motion.length,0);assert.equal(fw.configurationTraffic.writes,traffic.writes);assert.equal(fw.configurationTraffic.rejectedShutdownCommands,2);assert.equal(send('get_clock')[0].name,'clock');
  send('reset');assert.deepEqual(fw.configuration,{configured:false,crc:0,shutdown:false});assert.deepEqual({...send('get_config').find(m=>m.name==='config')!.parameters},{is_config:0,crc:0,is_shutdown:0,move_count:512});assert.equal(fw.configurationTraffic.resets,1);
 }finally{await fw.close();}
});
