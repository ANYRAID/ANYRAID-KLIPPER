import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { PrintJournal } from '../src/operations/print-journal.ts';
import { PrintController, type PrintDevice } from '../src/operations/print.ts';
const dir = mkdtempSync(
  join(process.env.PRINT_JOURNAL_BENCH_DIR ?? tmpdir(), 'recovery-bench-'),
);
const samples: {
  open: number;
  query: number;
  restore: number;
  cancel: number;
}[] = [];
try {
  for (let run = 0; run < 13; run++) {
    const options = { path: join(dir, `${run}.db`), deviceId: 'printer' };
    let journal = await PrintJournal.open(options);
    await journal.reserve({
      version: 1,
      requestId: 'job',
      fileId: 'file',
      nozzle: 210,
      bed: 60,
    });
    await journal.transition('job', 1, 'started');
    await journal.close();
    const begin = performance.now();
    journal = await PrintJournal.open(options);
    const open = performance.now() - begin;
    try {
      let stops = 0;
      const forbidden = async () => {
        throw new Error('Recovery replayed device action');
      };
      const device: PrintDevice = {
        prepare: forbidden,
        start: forbidden,
        pause: forbidden,
        resume: forbidden,
        finish: forbidden,
        stop: async () => {
          stops++;
        },
      };
      let query = 0,
        restore = 0,
        controller!: PrintController;
      const measureQuery = async () => {
        const begun = performance.now();
        assert.equal((await journal.active())?.state, 'interrupted');
        query = performance.now() - begun;
      };
      const measureRestore = async () => {
        const begun = performance.now();
        controller = await PrintController.restore(
          device,
          { maxNozzle: 280, maxBed: 110 },
          {},
          { journal },
        );
        restore = performance.now() - begun;
      };
      if (run % 2) {
        await measureQuery();
        await measureRestore();
      } else {
        await measureRestore();
        await measureQuery();
      }
      assert.equal(stops, 0);
      assert.equal(controller.state, 'interrupted');
      const begun = performance.now();
      await controller.cancel();
      controller.reset('job');
      const cancel = performance.now() - begun;
      assert.equal(stops, 1);
      assert.equal((await journal.get('job'))?.state, 'cancelled');
      if (run >= 2) samples.push({ open, query, restore, cancel });
    } finally {
      await journal.close();
    }
    execFileSync('/usr/bin/python3', [
      '-c',
      "import sqlite3,sys;d=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);assert d.execute('select id,state,revision from requests').fetchall()==[('job','cancelled',4)]",
      options.path,
    ]);
  }
  const stats = (key: keyof (typeof samples)[number]) => {
    const values = samples.map((s) => s[key]).sort((a, b) => a - b);
    return { medianMs: values[5], p95Ms: values[10] };
  };
  console.log(
    JSON.stringify(
      {
        node: process.version,
        filesystem: execFileSync('stat', ['-f', '-c', '%T', dir], {
          encoding: 'utf8',
        }).trim(),
        warmups: 2,
        samples: 11,
        reopenAndInterrupt: stats('open'),
        activeQuery: stats('query'),
        controllerRestore: stats('restore'),
        stopCommitReset: stats('cancel'),
        scope:
          'Actual database reopen and durable cancellation; immediate simulated stop ACK. Not physical printer recovery or power-cut validation.',
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
