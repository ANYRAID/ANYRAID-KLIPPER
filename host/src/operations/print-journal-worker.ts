import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, openSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  JournalError,
  journalRequest,
  printStatistics,
  validJournalId,
  type JournalRecord,
  type JournalState,
  type JournalOptions,
} from './print-journal-types.ts';
const schema =
  "CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1),device_id TEXT NOT NULL) STRICT;\nCREATE TABLE requests (id TEXT PRIMARY KEY,request TEXT NOT NULL CHECK(length(request)<=2048),state TEXT NOT NULL CHECK(state IN ('reserved','started','completed','cancelled','failed','interrupted')),revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991)) STRICT;\nCREATE UNIQUE INDEX one_active ON requests((1)) WHERE state NOT IN ('completed','cancelled');";
const normalized = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const statisticsSchema='CREATE TABLE request_statistics (id TEXT PRIMARY KEY,statistics TEXT NOT NULL CHECK(length(statistics)<=512)) STRICT;';
const port = parentPort!;
const options = workerData as JournalOptions;
let db: DatabaseSync | undefined,
  closed = false;
const states = new Set<JournalState>([
  'reserved',
  'started',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
]);
const allowed: Record<JournalState, readonly JournalState[]> = {
  reserved: ['started', 'cancelled', 'failed'],
  started: ['completed', 'cancelled', 'failed'],
  failed: ['cancelled'],
  interrupted: ['cancelled'],
  completed: [],
  cancelled: [],
};
const errorData = (error: unknown) => ({
  code: error instanceof JournalError ? error.code : 'DATABASE',
  message: (error instanceof Error ? error.message : String(error)).slice(
    0,
    2048,
  ),
});
function record(
  row: Record<string, unknown> | undefined,
): JournalRecord | null {
  if (!row) return null;
  try {
    const request = journalRequest(JSON.parse(String(row.request))),
      state = row.state as JournalState,
      revision = Number(row.revision);
    if (
      JSON.stringify(request) !== row.request ||
      request.requestId !== row.id ||
      !states.has(state) ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    )
      throw new JournalError('CORRUPT', 'Invalid persisted print record');
    const statistics=row.statistics==null?undefined:printStatistics(JSON.parse(String(row.statistics)));
    if(statistics&&JSON.stringify(statistics)!==row.statistics)throw new JournalError('CORRUPT','Invalid persisted print statistics');
    return { request, state, revision,...statistics?{statistics}:{} };
  } catch {
    throw new JournalError('CORRUPT', 'Invalid persisted print record');
  }
}
function lookup(id: string) {
  return record(
    db!
      .prepare('SELECT requests.*,request_statistics.statistics FROM requests LEFT JOIN request_statistics USING(id) WHERE requests.id=?')
      .get(id),
  );
}
function active() {
  return record(
    db!
      .prepare(
        "SELECT requests.*,request_statistics.statistics FROM requests LEFT JOIN request_statistics USING(id) WHERE state NOT IN ('completed','cancelled')",
      )
      .get(),
  );
}
function transaction<T>(action: () => T): T {
  db!.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db!.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db!.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}
function initialize() {
  if (
    !options ||
    !isAbsolute(options.path) ||
    options.path.includes('\0') ||
    !validJournalId(options.deviceId)
  )
    throw new JournalError(
      'INVALID',
      'Invalid journal path or device identity',
    );
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 65536 ||
    maxBytes > 64 * 1024 * 1024
  )
    throw new JournalError('INVALID', 'Invalid journal byte limit');
  const max = options.maxRequests ?? 10000;
  if (!Number.isSafeInteger(max) || max < 1 || max > 100000)
    throw new JournalError('INVALID', 'Invalid journal capacity');
  try {
    const fd = openSync(options.path, 'wx', 0o600);
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(options.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
    throw new JournalError(
      'INVALID',
      'Journal must be a regular file within the configured byte limit',
    );
  db = new DatabaseSync(options.path, { timeout: 50 });
  db.enableDefensive(true);
  const app = Number(db.prepare('PRAGMA application_id').get()!.application_id),
    version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  const tables = db
    .prepare(
      "SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  if (!(
    (app === 0 && version === 0 && tables.length === 0) ||
    (app === 0x4152504a && (version === 1||version===2))
  ))
    throw new JournalError('SCHEMA', 'Unknown print journal schema');
  if (version === 1||version===2) {
    const expected = (schema+(version===2?statisticsSchema:''))
        .split(';')
        .map((s) => normalized(s))
        .filter(Boolean)
        .sort(),
      actual = tables.map((row) => normalized(String(row.sql))).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      throw new JournalError(
        'SCHEMA',
        'Print journal schema does not match version',
      );
  }
  db.exec(
    'PRAGMA trusted_schema=OFF; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=EXTRA; PRAGMA journal_mode=DELETE',
  );
  const pageSize = Number(db.prepare('PRAGMA page_size').get()!.page_size);
  db.exec(`PRAGMA max_page_count=${Math.floor(maxBytes / pageSize)}`);
  transaction(() => {
    if (version === 0) {
      db!.exec(
        schema + statisticsSchema+' PRAGMA application_id=0x4152504a; PRAGMA user_version=2;',
      );
      db!.prepare('INSERT INTO metadata VALUES(1,?)').run(options.deviceId);
    }
    if(version===1)db!.exec(statisticsSchema+' PRAGMA user_version=2;');
    if (db!.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
      throw new JournalError('CORRUPT', 'Print journal integrity check failed');
    const identity = db!
      .prepare('SELECT device_id FROM metadata WHERE id=1')
      .get();
    if (identity?.device_id !== options.deviceId)
      throw new JournalError('DEVICE', 'Journal belongs to a different device');
    const existing = active();
    if (existing && existing.state !== 'interrupted')
      db!
        .prepare(
          "UPDATE requests SET state='interrupted',revision=revision+1 WHERE id=?",
        )
        .run(existing.request.requestId);
  });
  const info = {
    sqlite: String(
      db.prepare('SELECT sqlite_version() AS version').get()!.version,
    ),
    synchronous: Number(db.prepare('PRAGMA synchronous').get()!.synchronous),
    lockingMode: String(db.prepare('PRAGMA locking_mode').get()!.locking_mode),
    journalMode: String(db.prepare('PRAGMA journal_mode').get()!.journal_mode),
    maxRequests: max,
    maxBytes,
  };
  if (
    info.synchronous !== 3 ||
    info.lockingMode !== 'exclusive' ||
    info.journalMode !== 'delete'
  )
    throw new JournalError(
      'DATABASE',
      'Journal durability settings not applied',
    );
  return info;
}
function dispatch(method: string, args: unknown[]): unknown {
  if (closed) throw new JournalError('CLOSED', 'Print journal is closed');
  if (method === 'close') {
    closed = true;
    db!.close();
    return null;
  }
  if (method === 'active') return active();
  if (method === 'get') {
    if (!validJournalId(args[0]))
      throw new JournalError('INVALID', 'Invalid request identity');
    return lookup(args[0]);
  }
  if (method === 'reserve') {
    const request = journalRequest(args[0]),
      json = JSON.stringify(request);
    return transaction(() => {
      const prior = lookup(request.requestId);
      if (prior) {
        if (JSON.stringify(prior.request) !== json)
          throw new JournalError(
            'CONFLICT',
            'Print request identity conflicts',
          );
        return { created: false, record: prior };
      }
      if (active())
        throw new JournalError(
          'ACTIVE',
          'Another print requires terminal acknowledgement',
        );
      if (
        Number(
          db!.prepare('SELECT count(*) AS count FROM requests').get()!.count,
        ) >= (options.maxRequests ?? 10000)
      )
        throw new JournalError('CAPACITY', 'Print journal capacity reached');
      db!
        .prepare("INSERT INTO requests VALUES(?,?,'reserved',1)")
        .run(request.requestId, json);
      return { created: true, record: lookup(request.requestId)! };
    });
  }
  if (method === 'transition') {
    const [id, revision, state, rawStatistics] = args;
    const statistics=rawStatistics===undefined?undefined:printStatistics(rawStatistics);
    if(statistics&&!['completed','cancelled','failed'].includes(String(state)))throw new JournalError('INVALID','Statistics require a terminal outcome');
    if (
      !validJournalId(id) ||
      !Number.isSafeInteger(revision) ||
      Number(revision) < 1 ||
      !states.has(state as JournalState)
    )
      throw new JournalError('INVALID', 'Invalid journal transition');
    return transaction(() => {
      const prior = lookup(id);
      if (!prior) throw new JournalError('MISSING', 'Print request not found');
      if (prior.revision !== revision)
        throw new JournalError('STALE', 'Print journal revision changed');
      if (!allowed[prior.state].includes(state as JournalState))
        throw new JournalError(
          'STATE',
          'Invalid print journal state transition',
        );
      db!
        .prepare('UPDATE requests SET state=?,revision=revision+1 WHERE id=?')
        .run(String(state), id);
      // Preserve the first frozen outcome through failure acknowledgement and
      // restart reconciliation; do not replace known values with missing data.
      if(statistics)db!.prepare('INSERT INTO request_statistics(id,statistics) VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(id,JSON.stringify(statistics));
      return lookup(id)!;
    });
  }
  throw new JournalError('INVALID', 'Unknown journal operation');
}
try {
  const info = initialize();
  port.postMessage({ ready: true, info });
  port.on(
    'message',
    (message: { id: number; method: string; args: unknown[] }) => {
      try {
        const value = dispatch(message.method, message.args);
        port.postMessage({ id: message.id, value });
        if (closed) port.close();
      } catch (error) {
        port.postMessage({ id: message.id, error: errorData(error) });
        if (!(error instanceof JournalError) || error.code === 'CORRUPT') {
          closed = true;
          try {
            db?.close();
          } catch {}
          port.close();
        }
      }
    },
  );
} catch (error) {
  closed = true;
  try {
    db?.close();
  } catch {}
  port.postMessage({ ready: false, error: errorData(error) });
  port.close();
}
