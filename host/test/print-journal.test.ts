import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PrintJournal, JournalError } from '../src/operations/print-journal.ts';
const request = {
  version: 1 as const,
  requestId: 'job1',
  fileId: 'file1',
  nozzle: 210,
  bed: 60,
};
const code = (expected: string) => (error: unknown) =>
  error instanceof JournalError && error.code === expected;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'journal-test-'));
  return {
    dir,
    options: { path: join(dir, 'print.sqlite'), deviceId: 'printer1' },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test('durable journal reserves once, rejects conflicts and stale transitions, and retains terminal records', async () => {
  const f = fixture();
  let journal: PrintJournal | undefined;
  try {
    journal = await PrintJournal.open({ ...f.options, maxRequests: 2 });
    assert.equal(journal.info.synchronous, 3);
    assert.equal(journal.info.lockingMode, 'exclusive');
    assert.equal(journal.info.journalMode, 'delete');
    const first = await journal.reserve(request);
    assert.equal(first.created, true);
    assert.equal(first.record.revision, 1);
    assert.equal((await journal.reserve({ ...request })).created, false);
    await assert.rejects(
      journal.reserve({ ...request, bed: 70 }),
      code('CONFLICT'),
    );
    await assert.rejects(
      journal.reserve({ ...request, requestId: 'job2' }),
      code('ACTIVE'),
    );
    const started = await journal.transition('job1', 1, 'started');
    assert.equal(started.revision, 2);
    await assert.rejects(
      journal.transition('job1', 1, 'completed'),
      code('STALE'),
    );
    await journal.transition('job1', 2, 'completed');
    assert.equal(await journal.active(), null);
    await journal.reserve({ ...request, requestId: 'job2' });
    await journal.transition('job2', 1, 'cancelled');
    await assert.rejects(
      journal.reserve({ ...request, requestId: 'job3' }),
      code('CAPACITY'),
    );
    await assert.rejects(
      journal.transition('job1', 3, 'started'),
      code('STATE'),
    );
    await journal.close();
    journal = await PrintJournal.open({ ...f.options, maxRequests: 2 });
    assert.equal((await journal.get('job1'))?.state, 'completed');
    assert.equal((await journal.reserve(request)).created, false);
    assert.equal(await journal.active(), null);
  } finally {
    await journal?.close();
    f.remove();
  }
});
test('exclusive ownership prevents a second writer and device identity mismatch cannot mutate history', async () => {
  const f = fixture();
  let journal: PrintJournal | undefined;
  try {
    journal = await PrintJournal.open(f.options);
    await journal.reserve(request);
    await assert.rejects(PrintJournal.open(f.options), /locked/);
    await journal.close();
    const before = readFileSync(f.options.path);
    await assert.rejects(
      PrintJournal.open({ ...f.options, deviceId: 'wrong' }),
      code('DEVICE'),
    );
    assert.deepEqual(readFileSync(f.options.path), before);
    journal = await PrintJournal.open(f.options);
    assert.equal((await journal.active())?.state, 'interrupted');
    await assert.rejects(
      journal.transition('job1', 2, 'started'),
      code('STATE'),
    );
    await journal.transition('job1', 2, 'cancelled');
  } finally {
    await journal?.close();
    f.remove();
  }
});
test('accepted writes drain before close; bounded queue rejects excess without losing ownership', async () => {
  const f = fixture();
  let journal: PrintJournal | undefined;
  try {
    journal = await PrintJournal.open(f.options);
    const pending = Array.from({ length: 64 }, () => journal!.get('job1'));
    assert.equal(journal.pendingRequests, 64);
    await assert.rejects(journal.get('job1'), code('CAPACITY'));
    const closing = journal.close();
    assert.equal(closing, journal.close());
    await assert.rejects(journal.reserve(request), code('CLOSED'));
    assert.deepEqual(await Promise.all(pending), Array(64).fill(null));
    await closing;
    assert.equal(journal.pendingRequests, 0);
    journal = await PrintJournal.open(f.options);
    const reserved = journal.reserve(request),
      closed = journal.close();
    await reserved;
    await closed;
    journal = await PrintJournal.open(f.options);
    assert.equal((await journal.active())?.state, 'interrupted');
  } finally {
    await journal?.close();
    f.remove();
  }
});
test('SIGKILL after acknowledged start leaves an interrupted reservation, never permission to replay', async () => {
  const f = fixture();
  let journal: PrintJournal | undefined;
  const url = pathToFileURL(
    resolve(import.meta.dirname, '../src/operations/print-journal.ts'),
  ).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {PrintJournal} from ${JSON.stringify(url)};const journal=await PrintJournal.open(JSON.parse(process.argv[1]));await journal.reserve(${JSON.stringify(request)});await journal.transition('job1',1,'started');process.stdout.write('ready\\n');setInterval(()=>{},1000);`,
      JSON.stringify(f.options),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    let output = '',
      error = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      error += chunk;
    });
    await new Promise<void>((yes, no) => {
      const timeout = setTimeout(
        () => no(new Error('Child startup timed out: ' + error)),
        5000,
      );
      child.stdout.on('data', () => {
        if (output.includes('ready')) {
          clearTimeout(timeout);
          yes();
        }
      });
      child.once('exit', () => {
        clearTimeout(timeout);
        no(new Error('Child exited: ' + error));
      });
    });
    await assert.rejects(PrintJournal.open(f.options), /locked/);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    journal = await PrintJournal.open(f.options);
    const active = await journal.active();
    assert.equal(active?.state, 'interrupted');
    assert.equal(active?.revision, 3);
    assert.deepEqual(active?.request, request);
    assert.equal((await journal.reserve(request)).created, false);
    await assert.rejects(
      journal.reserve({ ...request, requestId: 'job2' }),
      code('ACTIVE'),
    );
    await journal.transition('job1', 3, 'cancelled');
    assert.equal(
      (await journal.reserve({ ...request, requestId: 'job2' })).created,
      true,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    await journal?.close();
    f.remove();
  }
});
test('unknown schemas, symlinks and malformed requests fail closed', async () => {
  const f = fixture();
  let journal: PrintJournal | undefined;
  try {
    const other = new DatabaseSync(f.options.path);
    other.exec('CREATE TABLE unrelated(value TEXT)');
    other.close();
    const before = readFileSync(f.options.path);
    await assert.rejects(PrintJournal.open(f.options), code('SCHEMA'));
    assert.deepEqual(readFileSync(f.options.path), before);
    rmSync(f.options.path);
    writeFileSync(join(f.dir, 'target'), '');
    symlinkSync(join(f.dir, 'target'), f.options.path);
    await assert.rejects(PrintJournal.open(f.options), code('INVALID'));
    rmSync(f.options.path);
    journal = await PrintJournal.open(f.options);
    for (const value of [
      null,
      { ...request, nozzle: NaN },
      { ...request, fileId: '../x' },
    ])
      await assert.rejects(
        journal.reserve(value as typeof request),
        code('INVALID'),
      );
    assert.equal(await journal.active(), null);
    await assert.rejects(journal.get(''), code('INVALID'));
    await journal.close();
    const altered = new DatabaseSync(f.options.path);
    altered.exec('CREATE TABLE extra(value TEXT)');
    altered.close();
    await assert.rejects(PrintJournal.open(f.options), code('SCHEMA'));
  } finally {
    await journal?.close();
    f.remove();
  }
});

test('storage full closes the worker and preserves every previously acknowledged terminal record', async () => {
  const f = fixture();
  let journal: PrintJournal | undefined;
  try {
    journal = await PrintJournal.open({
      ...f.options,
      maxBytes: 65536,
      maxRequests: 10000,
    });
    let committed = 0,
      failed = false;
    for (let i = 0; i < 1000; i++) {
      const id = 'job' + i;
      try {
        await journal.reserve({
          ...request,
          requestId: id,
          fileId: 'f'.repeat(128),
        });
        await journal.transition(id, 1, 'started');
        await journal.transition(id, 2, 'completed');
        committed++;
      } catch (error) {
        assert.ok(error instanceof JournalError);
        assert.match(error.message, /full/);
        failed = true;
        break;
      }
    }
    assert.equal(failed, true);
    assert.ok(committed > 0);
    await journal.close();
    journal = await PrintJournal.open({ ...f.options, maxBytes: 131072 });
    for (let i = 0; i < committed; i++)
      assert.equal((await journal.get('job' + i))?.state, 'completed');
  } finally {
    await journal?.close();
    f.remove();
  }
});
test('malformed persisted payload closes the journal instead of forgetting an old request', async () => {
  const f = fixture();
  let journal: PrintJournal | undefined;
  try {
    journal = await PrintJournal.open(f.options);
    await journal.reserve(request);
    await journal.transition('job1', 1, 'cancelled');
    await journal.close();
    const db = new DatabaseSync(f.options.path);
    db.prepare('UPDATE requests SET request=? WHERE id=?').run(
      'not-json',
      'job1',
    );
    db.close();
    journal = await PrintJournal.open(f.options);
    await assert.rejects(journal.get('job1'), code('CORRUPT'));
    await assert.rejects(
      journal.reserve({ ...request, requestId: 'job2' }),
      code('CLOSED'),
    );
    await journal.close();
  } finally {
    await journal?.close();
    f.remove();
  }
});
