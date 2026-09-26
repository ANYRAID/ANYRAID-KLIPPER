import {workerEntry} from '../runtime/worker-entry.ts';
import { isAbsolute } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  JournalError,
  journalRequest,
  printStatistics,
  type PrintStatistics,
  type JournalPage,
  type JournalHistoryRecord,
  type JournalHistoryQuery,
  validJournalId,
  type JournalOptions,
  type JournalInfo,
  type JournalRecord,
  type JournalState,
} from './print-journal-types.ts';
import type { StartPrint } from './print.ts';
import type {NativeHistoryTotals,NativeHistoryReset} from './print-history-totals.ts';
export { JournalError } from './print-journal-types.ts';
export type {
  JournalOptions,
  JournalRecord,
  JournalState,
  JournalInfo,
} from './print-journal-types.ts';
/** Durable request metadata only. No device commands or automatic print replay. */
export class PrintJournal {
  #worker: Worker;
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  #next = 0;
  #closed = false;
  #closing: Promise<void> | undefined;
  #ready: Promise<JournalInfo>;
  #exited: Promise<void>;
  #info!: Readonly<JournalInfo>;
  get info(): Readonly<JournalInfo> {
    return this.#info;
  }
  get pendingRequests(): number {
    return this.#pending.size;
  }
  private constructor(options: JournalOptions) {
    this.#worker = new Worker(
      workerEntry('./print-journal-worker.ts',import.meta.url),
      { workerData: options, execArgv: [] },
    );
    let ready!: (info: JournalInfo) => void, failed!: (error: unknown) => void;
    this.#ready = new Promise((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    const fail = (error: unknown) => {
      this.#closed = true;
      failed(error);
      for (const request of this.#pending.values()) request.reject(error);
      this.#pending.clear();
    };
    this.#worker.on('message', (message) => {
      if ('ready' in message) {
        if (message.ready) ready(message.info);
        else
          failed(new JournalError(message.error.code, message.error.message));
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error)
        pending.reject(
          new JournalError(message.error.code, message.error.message),
        );
      else pending.resolve(message.value);
    });
    this.#worker.on('error', fail);
    this.#exited = new Promise((resolve) =>
      this.#worker.once('exit', () => {
        fail(new JournalError('CLOSED', 'Print journal worker exited'));
        resolve();
      }),
    );
  }
  static async open(options: JournalOptions): Promise<PrintJournal> {
    if (
      !options ||
      typeof options.path !== 'string' ||
      !isAbsolute(options.path) ||
      options.path.includes('\0') ||
      Buffer.byteLength(options.path) > 4096 ||
      !validJournalId(options.deviceId)
    )
      throw new JournalError(
        'INVALID',
        'Invalid journal path or device identity',
      );
    const maxRequests = options.maxRequests ?? 10000;
    if (
      !Number.isSafeInteger(maxRequests) ||
      maxRequests < 1 ||
      maxRequests > 100000
    )
      throw new JournalError('INVALID', 'Invalid journal capacity');
    const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 65536 ||
      maxBytes > 64 * 1024 * 1024
    )
      throw new JournalError('INVALID', 'Invalid journal byte limit');
    const journal = new PrintJournal({
      path: options.path,
      deviceId: options.deviceId,
      maxRequests,
      maxBytes,
    });
    try {
      journal.#info = Object.freeze(await journal.#ready);
      return journal;
    } catch (error) {
      await journal.#worker.terminate();
      await journal.#exited;
      throw error;
    }
  }
  #call(method: string, args: unknown[], closing = false): Promise<unknown> {
    if (this.#closed || (this.#closing && !closing))
      return Promise.reject(
        new JournalError('CLOSED', 'Print journal is closing'),
      );
    if (this.#pending.size >= 64 && !closing)
      return Promise.reject(
        new JournalError('CAPACITY', 'Print journal request queue is full'),
      );
    if (this.#next === Number.MAX_SAFE_INTEGER && !closing)
      return Promise.reject(
        new JournalError(
          'CAPACITY',
          'Print journal request sequence exhausted',
        ),
      );
    const id = closing ? 0 : ++this.#next;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#worker.postMessage({ id, method, args });
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }
  reserve(
    input: StartPrint,
  ): Promise<{ created: boolean; record: JournalRecord }> {
    let request: StartPrint;
    try {
      request = journalRequest(input);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#call('reserve', [request]) as Promise<{
      created: boolean;
      record: JournalRecord;
    }>;
  }
  get(requestId: string): Promise<JournalRecord | null> {
    if (!validJournalId(requestId))
      return Promise.reject(
        new JournalError('INVALID', 'Invalid request identity'),
      );
    return this.#call('get', [requestId]) as Promise<JournalRecord | null>;
  }
  active(): Promise<JournalRecord | null> {
    return this.#call('active', []) as Promise<JournalRecord | null>;
  }
  /** Bounded lexical traversal for reconciliation, not a frozen snapshot.
   * A subsequent full scan observes insertions/updates before an older cursor. */
  scan(after?:string,limit=100):Promise<JournalPage>{
    if(after!==undefined&&!validJournalId(after)||!Number.isSafeInteger(limit)||limit<1||limit>256)return Promise.reject(new JournalError('INVALID','Invalid journal page'));
    return this.#call('scan',[after,limit]) as Promise<JournalPage>;
  }
  historyList(query:JournalHistoryQuery={}):Promise<JournalHistoryRecord[]>{return this.#call('historyList',[query]) as Promise<JournalHistoryRecord[]>;}
  historyGet(id:string):Promise<JournalHistoryRecord|null>{return this.#call('historyGet',[id]) as Promise<JournalHistoryRecord|null>;}
  historyDelete(id:string,all=false):Promise<{deleted_jobs:string[]}>{return this.#call('historyDelete',[id,all]) as Promise<{deleted_jobs:string[]}>;}
  historyTotals():Promise<NativeHistoryTotals>{return this.#call('historyTotals',[]) as Promise<NativeHistoryTotals>;}
  historyResetTotals():Promise<NativeHistoryReset>{return this.#call('historyResetTotals',[]) as Promise<NativeHistoryReset>;}
  transition(
    requestId: string,
    revision: number,
    state: JournalState,
    statistics?:PrintStatistics,
  ): Promise<JournalRecord> {
    if (
      !validJournalId(requestId) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      ![
        'reserved',
        'started',
        'completed',
        'cancelled',
        'failed',
        'interrupted',
      ].includes(state)
    )
      return Promise.reject(
        new JournalError('INVALID', 'Invalid journal transition'),
      );
    let snapshot:PrintStatistics|undefined;try{if(statistics!==undefined)snapshot=printStatistics(statistics);}catch(error){return Promise.reject(error);}
    return this.#call('transition', [
      requestId,
      revision,
      state,
      snapshot,
    ]) as Promise<JournalRecord>;
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      try {
        if (!this.#closed) await this.#call('close', [], true);
      } catch (error) {
        if (!(error instanceof JournalError) || error.code !== 'CLOSED')
          throw error;
      } finally {
        await this.#exited;
      }
    })();
    return this.#closing;
  }
}
