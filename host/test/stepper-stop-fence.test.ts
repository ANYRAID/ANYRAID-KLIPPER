import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StepperStopFence } from './helpers/stepper-stop-fence.ts';
import type { AcceptedFirmwareCommand } from './helpers/serial-firmware.ts';
import { serialFirmware } from './helpers/serial-firmware.ts';
import { EventEmitter } from 'node:events';
import { encodeFrame } from '../src/protocol/codec.ts';

for (const sanitizer of ['undefined', 'address,undefined']) test(`wire stop model matches actual stepper/trsync C handlers (${sanitizer})`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'stepper-stop-firmware-'));
  try {
    const helpers = fileURLToPath(new URL('./helpers/', import.meta.url)), binary = join(directory, 'test');
    execFileSync(process.env.CC ?? 'cc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-unused-parameter', '-fsanitize=' + sanitizer, '-fno-sanitize-recover=all', ...(sanitizer.includes('address') ? ['-fno-pie', '-no-pie'] : []), '-I' + join(helpers, 'stepper-stop-firmware'), '-I' + join(helpers, 'output-firmware'), join(helpers, 'stepper-stop-firmware/test.c'), '-o', binary], { timeout: 60000, stdio: 'pipe' });
    const reference = JSON.parse(execFileSync(binary, { encoding: 'utf8', timeout: 10000 }));
    const model = new StepperStopFence(() => 2050000), positions = [-24, -24];
    const command = (name: string, parameters: Record<string, number>) => {
      const accepted = model.observe({ name, parameters } as AcceptedFirmwareCommand);
      if (name === 'queue_step' && accepted) positions[parameters.oid] += model.direction(parameters.oid) * parameters.count;
    };
    command('trsync_start', { oid: 8 }); command('stepper_stop_on_trigger', { oid: 0, trsync_oid: 8 });
    command('trsync_trigger', { oid: 8, reason: 1 }); assert.equal(positions[0], reference.afterStop);
    command('queue_step', { oid: 0, interval: 1000, count: 20, add: 0 }); assert.equal(positions[0], reference.afterLate);
    command('reset_step_clock', { oid: 1, clock: 2000000 });
    command('queue_step', { oid: 1, interval: 1000, count: 20, add: 0 }); assert.equal(positions[1], reference.unboundAfterLate);
    command('reset_step_clock', { oid: 0, clock: 2100000 }); command('set_next_step_dir', { oid: 0, dir: 1 });
    command('queue_step', { oid: 0, interval: 1000, count: 16, add: 0 }); assert.equal(positions[0], reference.afterReset);
    command('trsync_trigger', { oid: 8, reason: 1 });
    command('queue_step', { oid: 0, interval: 1000, count: 2, add: 0 }); assert.equal(positions[0], reference.afterDuplicate);
    // The previous receive-count fixture would turn stopped -24 into -44.
    assert.equal(reference.afterStop - 20, -44); assert.notEqual(reference.afterLate, -44);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('per-MCU stop ownership, one-shot trigger and bounded clock observation', () => {
  const a = new StepperStopFence(() => 1000), b = new StepperStopFence(() => 2000);
  const command = (model: StepperStopFence, name: string, parameters: Record<string, number>) => model.observe({ name, parameters } as AcceptedFirmwareCommand);
  for (const model of [a, b]) { command(model, 'trsync_start', { oid: 8 }); command(model, 'stepper_stop_on_trigger', { oid: 0, trsync_oid: 8 }); }
  a.trigger(8);
  assert.equal(command(a, 'queue_step', { oid: 0, interval: 1000, count: 20, add: 0 }), false);
  assert.equal(command(b, 'queue_step', { oid: 0, interval: 1000, count: 20, add: 0 }), true);
  // trsync_start does not clear SF_NEED_RESET; only reset_step_clock may.
  command(a, 'trsync_start', { oid: 8 });
  assert.equal(command(a, 'queue_step', { oid: 0, interval: 1000, count: 20, add: 0 }), false);
  command(a, 'reset_step_clock', { oid: 0, clock: 1000 });
  assert.equal(command(a, 'queue_step', { oid: 0, interval: 100, count: 3, add: 5 }), true);
  assert.deepEqual(a.observation.events.at(-1), { sequence: 8, receivedClock: 1000, kind: 'queue_step', oid: 0, interval: 100, count: 3, add: 5, direction: -1, discarded: false, firstClock: 1100, endClock: 1315 });
  for (let i = 0; i < 200; i++) command(a, 'queue_step', { oid: 0, interval: 100, count: 1, add: 0 });
  assert.equal(a.observation.events.length, 128); assert.equal(a.observation.dropped, 80);
});
test('accepted late step frame cannot contaminate a stopped position query; explicit reset admits the retract', async () => {
  const peer = new EventEmitter() as EventEmitter & { write(data: Uint8Array): void }, replies: Uint8Array[] = [];
  peer.write = data => { replies.push(data); };
  const firmware = await serialFirmware({ fd: -1, peer, close: async () => {} }, { triggerSync: true });
  const fence = new StepperStopFence(() => 2050000);
  let position = -24, sequence = 1;
  firmware.setStepperPosition(0, position);
  const detach = firmware.observeCommands(command => {
    if (fence.observe(command) && command.name === 'queue_step') {
      position += fence.direction(Number(command.parameters.oid)) * Number(command.parameters.count);
      firmware.setStepperPosition(0, position);
    }
  });
  const send = (commands: [string, Record<string, number>][]) => peer.emit('data', encodeFrame(sequence++ & 15, Buffer.concat(commands.map(([name, params]) => firmware.dictionary.encode(name, params)))));
  const latestPosition = () => replies.flatMap(reply => firmware.dictionary.parseFrame(reply)).findLast(reply => reply.name === 'stepper_position')!.parameters.pos;
  try {
    send([['trsync_start', { oid: 8, report_clock: 2000000, report_ticks: 1000, expire_reason: 4 }], ['stepper_stop_on_trigger', { oid: 0, trsync_oid: 8 }]]);
    fence.trigger(8); // Physical endstop precedes the late transport frame.
    send([['queue_step', { oid: 0, interval: 1000, count: 20, add: 0 }], ['stepper_get_position', { oid: 0 }]]);
    assert.equal(firmware.motion.length, 1); // Command really accepted, not filtered by a duplicate-frame decoder.
    assert.equal(latestPosition(), -24); assert.equal(position, -24);
    assert.equal((fence.observation.events.at(-1) as { discarded: boolean }).discarded, true);
    send([['reset_step_clock', { oid: 0, clock: 2100000 }], ['set_next_step_dir', { oid: 0, dir: 1 }], ['queue_step', { oid: 0, interval: 1000, count: 16, add: 0 }], ['stepper_get_position', { oid: 0 }]]);
    assert.equal(latestPosition(), -8); assert.equal(position, -8);
  } finally { detach(); await firmware.close(); }
});
