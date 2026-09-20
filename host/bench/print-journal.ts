import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { PrintJournal } from '../src/operations/print-journal.ts';
import { PrintController } from '../src/operations/print.ts';
const integrated = process.env.PRINT_JOURNAL_BENCH_CONTROLLER === '1';
const dir = mkdtempSync(
  join(process.env.PRINT_JOURNAL_BENCH_DIR ?? tmpdir(), 'journal-bench-'),
);
const starts: number[] = [],
  samples: number[] = [],
  delays: number[] = [],
  ticks: number[] = [];
const jobs = 200;
let info;
try {
  for (let run = 0; run < 13; run++) {
    const path = join(dir, `run${run}.sqlite`),
      start = performance.now(),
      journal = await PrintJournal.open({ path, deviceId: 'bench' });
    let effects = 0;
    const controller = new PrintController(
      {
        prepare: async () => {
          effects++;
        },
        start: async () => {
          effects++;
        },
        finish: async () => {
          effects++;
        },
        pause: async () => {
          throw new Error('Unexpected pause');
        },
        resume: async () => {
          throw new Error('Unexpected resume');
        },
        stop: async () => {
          throw new Error('Unexpected stop');
        },
      },
      { maxNozzle: 280, maxBed: 110 },
      {},
      { journal },
    );
    const startup = performance.now() - start;
    info = journal.info;
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    let tickCount = 0;
    const timer = setInterval(() => tickCount++, 1);
    const begun = performance.now();
    try {
      for (let i = 0; i < jobs; i++) {
        const id = 'job' + i;
        if (integrated) {
          await controller.start({
            version: 1,
            requestId: id,
            fileId: 'file',
            nozzle: 210,
            bed: 60,
          });
          await controller.complete(id);
          controller.reset(id);
          continue;
        }
        assert.equal(
          (
            await journal.reserve({
              version: 1,
              requestId: id,
              fileId: 'file',
              nozzle: 210,
              bed: 60,
            })
          ).created,
          true,
        );
        await journal.transition(id, 1, 'started');
        await journal.transition(id, 2, 'completed');
      }
    } finally {
      clearInterval(timer);
      histogram.disable();
    }
    assert.equal(effects, integrated ? jobs * 3 : 0);
    const elapsed = performance.now() - begun;
    const delay = histogram.max / 1e6;
    await journal.close();
    const oracle = spawnSync(
      '/usr/bin/python3',
      [
        '-c',
        "import sqlite3,sys,json;d=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);rows=d.execute('select id,request,state,revision from requests').fetchall();assert len(rows)==200;assert len({r[0] for r in rows})==200;assert all(r[2]=='completed' and r[3]==3 and json.loads(r[1])==dict(version=1,requestId=r[0],fileId='file',nozzle=210,bed=60) for r in rows);print('verified')",
        path,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(oracle.status, 0, oracle.stderr);
    assert.ok(tickCount > 0);
    if (run >= 2) {
      starts.push(startup);
      samples.push(elapsed);
      delays.push(delay);
      ticks.push(tickCount);
    }
  }
  const stats = (values: number[]) => {
    values.sort((a, b) => a - b);
    return { medianMs: values[5], p95Ms: values[10] };
  };
  console.log(
    JSON.stringify(
      {
        node: process.version,
        integratedController: integrated,
        filesystem: execFileSync('stat', ['-f', '-c', '%T', dir], {
          encoding: 'utf8',
        }).trim(),
        info,
        warmups: 2,
        samples: 11,
        jobsPerSample: jobs,
        commitsPerJob: 3,
        startup: stats(starts),
        workerWrites: stats(samples),
        meanMillisecondsPerJob: samples[5] / jobs,
        maxObservedMainLoopDelayMs: Math.max(...delays),
        minimumTimerTicks: Math.min(...ticks),
        scope:
          'Real separate SQLite files, DELETE journal / EXTRA synchronization, Worker IPC and three committed job transitions. Python independently verifies every closed database. Local filesystem timing; not power-cut or target-board validation.',
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
