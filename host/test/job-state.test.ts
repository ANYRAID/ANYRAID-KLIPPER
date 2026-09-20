import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { JobState } from '../src/moonraker/job-state.ts';
import { jobStateOracle } from './helpers/job-state-oracle.ts';
const states = [
  'standby',
  'printing',
  'paused',
  'complete',
  'cancelled',
  'error',
];
test('job state transition and layer events match pinned Moonraker Python', () => {
  const cases = states.flatMap((state) =>
    states.flatMap((next) =>
      [0, 1, 2].map((mode) => ({
        initial: { state, filename: 'part.gcode', total_duration: 10 },
        updates: [
          {
            state: next,
            filename: mode === 2 ? 'other.gcode' : 'part.gcode',
            total_duration: mode === 0 ? 0 : 11,
            info: { current_layer: 3, total_layer: 20 },
          },
        ],
        disconnect: true,
      })),
    ),
  );
  const expected = spawnSync('/usr/bin/python3', ['-c', jobStateOracle()], {
    input: JSON.stringify(cases),
    encoding: 'utf8',
  });
  assert.equal(expected.status, 0, expected.stderr);
  const actual = cases.map((c) => {
    const job = new JobState();
    job.initialize(c.initial);
    const events = c.updates.flatMap((delta) => [...job.update(delta)]);
    job.disconnect();
    return { events, stats: job.lastStats, event: job.lastEvent };
  });
  assert.deepEqual(actual, JSON.parse(expected.stdout));
});
test('job state snapshots isolate owners and invalid input leaves state unchanged', () => {
  const job = new JobState();
  job.initialize({ state: 'standby', filename: 'a', total_duration: 0 });
  const events = job.update({ state: 'printing', info: { current_layer: 1 } });
  assert.equal(events.length, 2);
  const copy = job.lastStats as Record<string, unknown>;
  copy.state = 'error';
  assert.equal(job.lastStats.state, 'printing');
  assert.throws(() => job.update({ state: 'unknown' }));
  assert.throws(() =>
    job.update({ info: { current_layer: 9007199254740992 } }),
  );
  assert.equal(job.lastEvent, 'started');
  assert.equal(job.lastStats.state, 'printing');
  assert.deepEqual(job.update({ total_duration: 2 }), []);
  job.disconnect();
  assert.equal(job.lastEvent, 'error');
});
test('unknown layer counts match real Klippy reset and upstream nullable layer events', () => {
  const cases = [
    {
      initial: {
        state: 'standby',
        info: { current_layer: null, total_layer: null },
      },
      updates: [{ info: { current_layer: null, total_layer: null } }],
    },
    {
      initial: { state: 'printing', filename: 'a', total_duration: 0 },
      updates: [{ info: { current_layer: 1, total_layer: null } }],
    },
    {
      initial: { state: 'printing', filename: 'a', total_duration: 0 },
      updates: [{ info: { current_layer: 1 } }],
    },
  ];
  const py = spawnSync('/usr/bin/python3', ['-c', jobStateOracle()], {
    input: JSON.stringify(cases),
    encoding: 'utf8',
  });
  assert.equal(py.status, 0, py.stderr);
  const actual = cases.map((c) => {
    const job = new JobState();
    job.initialize(c.initial);
    return {
      events: c.updates.flatMap((u) => [...job.update(u)]),
      stats: job.lastStats,
      event: job.lastEvent,
    };
  });
  assert.deepEqual(actual, JSON.parse(py.stdout));
});
test('job state initialization and accumulated fields share an atomic capacity limit', () => {
  const job = new JobState(),
    full = Object.fromEntries(
      Array.from({ length: 256 }, (_, i) => ['field' + i, i]),
    );
  job.initialize(full);
  assert.throws(() => job.initialize({ ...full, extra: 0 }), /Too many/);
  assert.throws(() => job.update({ extra: 0 }), /Too many/);
  assert.deepEqual(job.lastStats, full);
});
