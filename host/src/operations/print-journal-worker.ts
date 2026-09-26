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
const timesSchema='CREATE TABLE request_times (id TEXT PRIMARY KEY,reserved_at REAL CHECK(reserved_at>=0),started_at REAL CHECK(started_at>=0),ended_at REAL CHECK(ended_at>=0)) STRICT;';
const hiddenSchema='CREATE TABLE history_hidden (id TEXT PRIMARY KEY) STRICT;';
const visibleHistory='NOT EXISTS (SELECT 1 FROM history_hidden WHERE history_hidden.id=requests.id)';
const recordQuery="SELECT requests.*,printf('%06X',requests.rowid) AS history_id,request_statistics.statistics,request_times.id AS timed_id,reserved_at,started_at,ended_at FROM requests LEFT JOIN request_statistics USING(id) LEFT JOIN request_times USING(id)";
function wallTime():number{const value=Date.now()/1000;if(!Number.isFinite(value)||value<0)throw new JournalError('CLOCK','Invalid wall clock');return value;}
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
    const timestamps=row.timed_id==null?undefined:{reservedAt:row.reserved_at as number|null,startedAt:row.started_at as number|null,endedAt:row.ended_at as number|null};
    if(timestamps&&Object.values(timestamps).some(value=>value!==null&&(typeof value!=='number'||!Number.isFinite(value)||value<0)))throw new JournalError('CORRUPT','Invalid persisted print timestamps');
    return { request, state, revision,...statistics?{statistics}:{},...timestamps?{timestamps}:{} };
  } catch {
    throw new JournalError('CORRUPT', 'Invalid persisted print record');
  }
}
function lookup(id: string) {
  return record(
    db!
      .prepare(recordQuery+' WHERE requests.id=?')
      .get(id),
  );
}
function active() {
  return record(
    db!
      .prepare(
        recordQuery+" WHERE state NOT IN ('completed','cancelled')",
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
    (app === 0x4152504a && (version >=1&&version<=4))
  ))
    throw new JournalError('SCHEMA', 'Unknown print journal schema');
  if (version >=1) {
    const expected = (schema+(version>=2?statisticsSchema:'')+(version>=3?timesSchema:'')+(version>=4?hiddenSchema:''))
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
        schema + statisticsSchema+timesSchema+hiddenSchema+' PRAGMA application_id=0x4152504a; PRAGMA user_version=4;',
      );
      db!.prepare('INSERT INTO metadata VALUES(1,?)').run(options.deviceId);
    }
    if(version===1)db!.exec(statisticsSchema+' PRAGMA user_version=2;');
    if(version===1||version===2)db!.exec(timesSchema+' PRAGMA user_version=3;');
    if(version>=1&&version<=3)db!.exec(hiddenSchema+' PRAGMA user_version=4;');
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
  if(method==='historyGet'){
    const id=args[0];if(typeof id!=='string'||!/^[0-9a-fA-F]{1,16}$/.test(id)||BigInt('0x'+id)<1n||BigInt('0x'+id)>(1n<<63n)-1n)throw new JournalError('INVALID','Invalid history uid');
    const row=db!.prepare(recordQuery+' WHERE requests.rowid=? AND '+visibleHistory).get(BigInt('0x'+id));return row?{...record(row)!,historyId:String(row.history_id)}:null;
  }
  if(method==='historyList'){
    const query=args[0] as import('./print-journal-types.ts').JournalHistoryQuery;
    if(!query||typeof query!=='object'||Array.isArray(query))throw new JournalError('INVALID','Invalid history query');
    const {before,since}=query,limit=query.limit??50,start=query.start??0,order=String(query.order??'desc').toUpperCase();
    if(!['ASC','DESC'].includes(order)||!Number.isSafeInteger(limit)||!Number.isSafeInteger(start)||[before,since].some(v=>v!==undefined&&!Number.isFinite(v)))throw new JournalError('INVALID','Invalid history pagination');
    if(limit>1000)throw new JournalError('CAPACITY','Use history pages of at most 1000 records');
    const params:(string|number)[]=[];let sql=recordQuery+' WHERE '+visibleHistory;
    if(before!==undefined&&before!==-1){sql+=' AND ended_at<?';params.push(before);}
    if(since!==undefined&&since!==-1){sql+=' AND reserved_at>?';params.push(since);}
    sql+=' ORDER BY requests.rowid '+order+' LIMIT ? OFFSET ?';params.push(limit>0?limit:1001,limit>0?Math.max(0,start):0);
    const rows=db!.prepare(sql).all(...params);if(rows.length>1000)throw new JournalError('CAPACITY','Use bounded history pagination');
    return rows.map(row=>({...record(row)!,historyId:String(row.history_id)}));
  }
  if(method==='historyDelete'){
    const [id,all]=args;
    if(typeof all!=='boolean'||!all&&(typeof id!=='string'||!/^[0-9a-fA-F]{1,16}$/.test(id)||BigInt('0x'+id)<1n||BigInt('0x'+id)>(1n<<63n)-1n))throw new JournalError('INVALID','Invalid history deletion');
    return transaction(()=>{
      const rows=all?db!.prepare("SELECT id,state,printf('%06X',rowid) AS uid FROM requests WHERE "+visibleHistory+' ORDER BY rowid LIMIT 1001').all():db!.prepare("SELECT id,state,printf('%06X',rowid) AS uid FROM requests WHERE rowid=? AND "+visibleHistory).all(BigInt('0x'+String(id)));
      if(!all&&!rows.length)throw new JournalError('MISSING','Unknown history job');
      if(rows.some(row=>!['completed','cancelled','failed'].includes(String(row.state))))throw new JournalError('STATE','Cannot delete unfinished history');
      // Do not silently partially delete when the response cannot list all IDs.
      if(rows.length>1000)throw new JournalError('CAPACITY','Delete history in bounded individual requests');
      const insert=db!.prepare('INSERT INTO history_hidden(id) VALUES(?)');for(const row of rows)insert.run(String(row.id));
      return {deleted_jobs:all?rows.map(row=>String(row.uid)):[String(id)]};
    });
  }
  if(method==='scan'){
    const [after,limit]=args;
    if(after!==undefined&&!validJournalId(after)||!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>256)throw new JournalError('INVALID','Invalid journal page');
    const records=db!.prepare(recordQuery+' WHERE requests.id>? ORDER BY requests.id LIMIT ?').all(after===undefined?'':String(after),Number(limit)).map(row=>record(row)!);
    return {records,nextAfter:records.length===limit?records.at(-1)!.request.requestId:null};
  }
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
      db!.prepare('INSERT INTO request_times(id,reserved_at) VALUES(?,?)').run(request.requestId,wallTime());
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
      const field=state==='started'?'started_at':'ended_at';
      // Reconciliation cannot establish when an interrupted job actually ended.
      // Keep an existing end time, but never substitute the recovery ACK time.
      if(prior.state!=='interrupted'&&prior.state!=='failed')db!.prepare(`INSERT INTO request_times(id,${field}) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET ${field}=COALESCE(request_times.${field},excluded.${field})`).run(id,wallTime());
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
