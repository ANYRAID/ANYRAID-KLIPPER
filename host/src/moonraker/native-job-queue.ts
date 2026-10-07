// Queue wire shapes follow Moonraker job_queue.py, GPL-3.0-or-later.
// Original Copyright (C) 2021 Eric Callahan. Product recovery never replays prints.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { DatabaseStore } from './database.ts';
import type { DatabaseNamespace } from './database-namespace.ts';
import { PrintJournal } from '../operations/print-journal.ts';
import { validJournalId } from '../operations/print-journal-types.ts';
import type { JournalHistoryEvent } from '../operations/print-journal-types.ts';
import { printFilename } from './print-api.ts';
import { historyBoolean } from './history-api.ts';
import { ApiError, type Json, type RpcContext } from './rpc.ts';
import type { EndpointRegistry } from './endpoints.ts';

export interface QueuedNativeJob {
  readonly job_id: string;
  readonly filename: string;
  readonly file_id: string;
  readonly time_added: number;
  readonly user: string | null;
}
interface Claim { job_id: string; request_id: string; file_id: string; }
interface Receipt { id: string; fingerprint: string; jobs: string[]; }
type QueueState = 'paused' | 'ready' | 'loading' | 'starting';
interface Catalogue {
  version: 1;
  revision: number;
  jobs: QueuedNativeJob[];
  claim: Claim | null;
  receipts: Receipt[];
}
export interface NativeJobQueueOptions {
  database: DatabaseStore;
  journal: PrintJournal;
  /** Same published-file owner as printing. Returns its immutable identity. */
  resolveFile(filename: string, signal: AbortSignal): Promise<string>;
  /** Current device availability. A queued item grants no device authority. */
  canStart(): boolean;
  /** Must use the existing print controller/journal, honor the immutable file
   * identity and reauthorize printer.print.start; never retry a device action.
   * Resolution means journal reservation, not physical print completion. */
  start(job: QueuedNativeJob, requestId: string, context: RpcContext): Promise<void>;
  notify?(event: Json): void | Promise<void>;
  maxJobs?: number;
  automaticTransition?: boolean;
  transitionDelayMs?: number;
  /** An explicit operator must confirm the immutable queue head before each
   * admission. No G-code, timer or restart can manufacture this confirmation. */
  confirmClearance?: boolean;
  confirmationTimeoutMs?: number;
  /** Trusted owner freezes the initiating principal and revalidates it on each
   * print. Never reconstruct authority from the persisted catalogue username. */
  captureAuthority?(context: RpcContext, lifetime: AbortSignal): RpcContext;
  /** Matching process controller only; no legacy or replacement generation. */
  activePrint?(): { requestId: string } | undefined;
}
interface Continuation {
  context: RpcContext;
  pause: number;
  requestId: string;
  finished?: JournalHistoryEvent;
  removeAbort: () => void;
}
interface Clearance {
  token: string; revision: number; job: QueuedNativeJob;
  completedRequestId: string | null; expiresAt: number; deadline: number;
  context: RpcContext; removeAbort: () => void;
  timer: ReturnType<typeof setTimeout>;
}
const namespace = 'native_job_queue';
const owners = new WeakSet<DatabaseStore>();
// Keep the private namespace registration until its database owner closes.
// Unregistering a queue must not expose durable queue identities to public APIs.
const registrations = new WeakMap<DatabaseStore, DatabaseNamespace>();
const empty = (): Catalogue => ({ version: 1, revision: 0, jobs: [], claim: null, receipts: [] });
const jobId = (value: unknown): value is string => typeof value === 'string' && /^[A-F0-9]{16}$/.test(value);
function fields(value: object, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function catalogue(value: Json, maxJobs: number): Catalogue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(503, 'Invalid persisted job queue');
  const v = value as unknown as Catalogue;
  if (!fields(v, ['version', 'revision', 'jobs', 'claim', 'receipts']) || v.version !== 1 || !Number.isSafeInteger(v.revision) || v.revision < 0 || !Array.isArray(v.jobs) || v.jobs.length > maxJobs || !Array.isArray(v.receipts) || v.receipts.length > 64)
    throw new ApiError(503, 'Invalid persisted job queue');
  const ids = new Set<string>();
  for (const job of v.jobs) {
    if (!job || typeof job !== 'object' || !fields(job, ['job_id', 'filename', 'file_id', 'time_added', 'user']) || !jobId(job.job_id) || ids.has(job.job_id) || !validJournalId(job.file_id) || !Number.isFinite(job.time_added) || job.time_added < 0 || job.user !== null && (typeof job.user !== 'string' || !job.user || !job.user.isWellFormed() || job.user.includes('\0') || Buffer.byteLength(job.user) > 4096))
      throw new ApiError(503, 'Invalid persisted queue member');
    try { if (printFilename(job.filename) !== job.filename) throw new Error(); } catch { throw new ApiError(503, 'Invalid persisted queue filename'); }
    ids.add(job.job_id);
  }
  if (v.claim !== null && (!v.claim || typeof v.claim !== 'object' || !fields(v.claim, ['job_id', 'request_id', 'file_id']) || !jobId(v.claim.job_id) || !validJournalId(v.claim.request_id) || !ids.has(v.claim.job_id) || v.jobs.find(j => j.job_id === v.claim!.job_id)!.file_id !== v.claim.file_id))
    throw new ApiError(503, 'Invalid persisted queue claim');
  const receiptIds = new Set<string>();
  for (const receipt of v.receipts) {
    if (!receipt || typeof receipt !== 'object' || !fields(receipt, ['id', 'fingerprint', 'jobs']) || !validJournalId(receipt.id) || receiptIds.has(receipt.id) || typeof receipt.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) || !Array.isArray(receipt.jobs) || receipt.jobs.length > maxJobs || receipt.jobs.some(id => !jobId(id)) || new Set(receipt.jobs).size !== receipt.jobs.length)
      throw new ApiError(503, 'Invalid persisted queue receipt');
    receiptIds.add(receipt.id);
  }
  return structuredClone(v);
}
function list(value: Json | undefined, key: string): string[] {
  const items = typeof value === 'string' ? value.split(',').map(v => v.trim()).filter(Boolean) : value;
  if (!Array.isArray(items) || !items.length || items.length > 128 || items.some(item => typeof item !== 'string' || !item))
    throw new ApiError(400, 'Missing or invalid queue ' + key);
  return items as string[];
}

/** Process catalogue only. PrintJournal remains the sole execution history.
 * Accepted writes are atomic and never cancelled or retried. Recovery resolves
 * a claim from that journal and always pauses, without calling start(). */
export class NativeJobQueue {
  readonly #options: NativeJobQueueOptions;
  readonly #namespace: DatabaseNamespace;
  readonly #maxJobs: number;
  #catalogue: Catalogue;
  #tail = Promise.resolve();
  #notifications = Promise.resolve();
  #pending = 0;
  #notificationPending = 0;
  #notificationDropped = 0;
  #notificationError: string | null = null;
  #storageFailed = false;
  #closing = false;
  #closed: Promise<void> | undefined;
  #pause = 0;
  #state: QueueState = 'paused';
  #dispatch: Promise<void> | undefined;
  #lifetime = new AbortController();
  #continuation: Continuation | undefined;
  #transitionTimer: ReturnType<typeof setTimeout> | undefined;
  #automaticTask: Promise<void> | undefined;
  #releaseHistory: (() => void) | undefined;
  #pauseRequested = false;
  #transitionError: string | null = null;
  #clearance: Clearance | undefined;
  private constructor(options: NativeJobQueueOptions, owner: DatabaseNamespace, value: Catalogue, maxJobs: number) {
    this.#options = options; this.#namespace = owner; this.#catalogue = value; this.#maxJobs = maxJobs;
  }
  static async open(options: NativeJobQueueOptions): Promise<NativeJobQueue> {
    const maxJobs = options.maxJobs ?? 128;
    if (!(options.database instanceof DatabaseStore) || !(options.journal instanceof PrintJournal) || options.journal.closed || !Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 128 || typeof options.resolveFile !== 'function' || typeof options.canStart !== 'function' || typeof options.start !== 'function' || options.notify !== undefined && typeof options.notify !== 'function')
      throw new TypeError('Invalid native job queue owner');
    if (options.automaticTransition !== undefined && typeof options.automaticTransition !== 'boolean' || options.transitionDelayMs !== undefined && (!Number.isFinite(options.transitionDelayMs) || options.transitionDelayMs <= 0 || options.transitionDelayMs > 2147483647)) throw new TypeError('Invalid queue transition policy');
    if (options.automaticTransition && (typeof options.captureAuthority !== 'function' || typeof options.activePrint !== 'function')) throw new TypeError('Automatic queue requires explicit print authority and controller');
    if (options.confirmClearance !== undefined && typeof options.confirmClearance !== 'boolean' || options.confirmationTimeoutMs !== undefined && (!Number.isFinite(options.confirmationTimeoutMs) || options.confirmationTimeoutMs < 1 || options.confirmationTimeoutMs > 900000)) throw new TypeError('Invalid queue confirmation policy');
    if (options.confirmClearance && typeof options.captureAuthority !== 'function') throw new TypeError('Queue confirmation requires explicit print authority');
    if (owners.has(options.database)) throw new TypeError('Job queue database already owned');
    owners.add(options.database);
    try {
      let owner = registrations.get(options.database);
      if (!owner) { owner = await options.database.registerLocalNamespace(namespace, { forbidden: true }); registrations.set(options.database, owner); }
      const present = await owner.contains('catalogue');
      const saved = present ? await owner.get('catalogue') : null;
      if (present && saved === null) throw new ApiError(503, 'Invalid persisted job queue');
      const queue = new NativeJobQueue({ ...options }, owner, saved === null ? empty() : catalogue(saved, maxJobs), maxJobs);
      if (saved === null) await owner.insert('catalogue', queue.#catalogue as unknown as Json);
      await queue.#recover();
      if (options.automaticTransition) queue.#releaseHistory = options.journal.subscribeHistory(event => queue.#observe(event));
      return queue;
    } catch (error) { owners.delete(options.database); throw error; }
  }
  get status() {
    const now = Date.now() / 1000;
    return {
      queued_jobs: this.#catalogue.jobs.map(job => ({ filename: job.filename, job_id: job.job_id, time_added: job.time_added, time_in_queue: Math.max(0, now - job.time_added) })),
      queue_state: this.#state,
      ...this.#options.confirmClearance ? { transition: this.#clearance ? {
        version: 1, phase: 'awaiting_confirmation', state_token: this.#clearance.token,
        job_id: this.#clearance.job.job_id, filename: this.#clearance.job.filename,
        completed_request_id: this.#clearance.completedRequestId, expires_at: this.#clearance.expiresAt,
      } : null } : {},
    };
  }
  get diagnostics() {
    return { revision: this.#catalogue.revision, pending: this.#pending, dispatching: !!this.#dispatch, claim: this.#catalogue.claim ? { ...this.#catalogue.claim } : null, storage_failed: this.#storageFailed, closed: this.#closing, automatic: { armed: !!this.#continuation, scheduled: !!this.#transitionTimer, error: this.#transitionError }, notifications: { pending: this.#notificationPending, dropped: this.#notificationDropped, error: this.#notificationError } };
  }
  #disarm(): void {
    this.#clearConfirmation();
    if (this.#transitionTimer) clearTimeout(this.#transitionTimer);
    this.#transitionTimer = undefined;
    this.#continuation?.removeAbort(); this.#continuation = undefined;
  }
  #clearConfirmation(): void {
    const clearance = this.#clearance; this.#clearance = undefined;
    if (clearance) { clearTimeout(clearance.timer); clearance.removeAbort(); }
  }
  #arm(context: RpcContext, requestId: string): Continuation {
    context.signal.throwIfAborted(); context.nativeGenerationSignal?.throwIfAborted();
    if (context.nativeGenerationRetiredAtAdmission || !context.nativeGenerationSignal) throw new ApiError(503, 'Automatic queue requires an attached device generation');
    this.#disarm(); this.#transitionError = null;
    const signals = [context.signal, context.nativeGenerationSignal];
    const revoke = () => { if (this.#continuation === lease) { this.#disarm(); this.#setState('paused'); } };
    const lease: Continuation = { context, pause: this.#pause, requestId, removeAbort: () => { for (const signal of signals) signal.removeEventListener('abort', revoke); } };
    this.#continuation = lease;
    for (const signal of signals) signal.addEventListener('abort', revoke, { once: true });
    return lease;
  }
  #observe(event: JournalHistoryEvent): void {
    const lease = this.#continuation;
    if (!lease || event.action !== 'finished' || event.record.request.requestId !== lease.requestId || lease.finished) return;
    lease.finished = event;
    if (event.record.state !== 'completed') { this.#disarm(); this.#setState('paused'); return; }
    this.#schedule(lease);
  }
  #schedule(lease: Continuation): void {
    if (this.#continuation !== lease || this.#closing || this.#storageFailed || lease.pause !== this.#pause || !lease.finished || this.#dispatch || this.#transitionTimer) return;
    if (!this.#catalogue.jobs.length) { this.#disarm(); this.#setState('paused'); return; }
    this.#setState('loading');
    this.#transitionTimer = setTimeout(() => {
      this.#transitionTimer = undefined;
      if (this.#continuation !== lease || lease.pause !== this.#pause || this.#closing) return;
      // Completion is durable before this callback; never retry a rejected
      // admission or substitute a new device/connection principal.
      const task = (async () => {
        try {
          lease.context.signal.throwIfAborted(); lease.context.nativeGenerationSignal?.throwIfAborted();
          if (!this.#options.canStart()) throw new ApiError(409, 'Completed queue device unavailable');
          if (this.#options.confirmClearance) await this.#requestConfirmation(lease.context, lease.requestId);
          else await this.#start(lease.context, true);
        } catch { this.#disarm(); this.#transitionError = 'Automatic print admission failed; explicitly restart the queue'; this.#setState('paused'); }
      })();
      this.#automaticTask = task;
      void task.finally(() => { if (this.#automaticTask === task) this.#automaticTask = undefined; });
    }, this.#options.transitionDelayMs ?? 10);
  }
  #assertWritable(): void {
    if (this.#closing || this.#storageFailed) throw new ApiError(503, 'Job queue requires recovery');
  }
  #serialize<T>(work: () => Promise<T>): Promise<T> {
    try { this.#assertWritable(); if (this.#pending >= 16) throw new ApiError(429, 'Job queue capacity exceeded'); } catch (error) { return Promise.reject(error); }
    this.#pending++;
    const result = this.#tail.then(work);
    this.#tail = result.then(() => {}, () => {}).finally(() => { this.#pending--; });
    return result;
  }
  async #commit(next: Catalogue, action: string): Promise<void> {
    this.#assertWritable();
    if (this.#catalogue.revision >= Number.MAX_SAFE_INTEGER) throw new ApiError(503, 'Job queue revision exhausted');
    next.revision = this.#catalogue.revision + 1;
    next = catalogue(next as unknown as Json, this.#maxJobs);
    try { await this.#namespace.insert('catalogue', next as unknown as Json); }
    catch (error) {
      // The database's validated capacity/backpressure rejection precedes commit
      // or rolls its transaction back. An unknown result instead needs recovery.
      if (!(error instanceof ApiError && [400, 409, 413, 429].includes(error.status))) { this.#storageFailed = true; this.#disarm(); this.#state = 'paused'; }
      throw error;
    }
    this.#catalogue = next;
    this.#clearConfirmation();
    this.#emit(action);
  }
  #emit(action = 'state_changed'): void {
    if (!this.#options.notify || this.#closing) return;
    if (this.#notificationPending >= 64) { this.#notificationDropped++; this.#notificationError = 'Refresh job queue after notification overflow'; return; }
    const event: Json = { action, updated_queue: action === 'state_changed' ? null : this.status.queued_jobs, queue_state: this.#state };
    this.#notificationPending++;
    this.#notifications = this.#notifications.then(async () => { if (!this.#closing) await this.#options.notify!(event); }).catch(error => { this.#notificationError = error instanceof Error ? error.message : 'Queue notification failed'; }).finally(() => { this.#notificationPending--; });
  }
  #setState(state: QueueState): void {
    if (this.#state !== state) { this.#state = state; this.#emit(); }
  }
  async #recover(): Promise<void> {
    const claim = this.#catalogue.claim;
    if (!claim) return;
    const record = await this.#options.journal.get(claim.request_id);
    if (record && record.request.fileId !== claim.file_id) throw new ApiError(503, 'Queue claim conflicts with print journal');
    const next = structuredClone(this.#catalogue);
    if (record) next.jobs = next.jobs.filter(job => job.job_id !== claim.job_id);
    next.claim = null;
    await this.#commit(next, record ? 'job_loaded' : 'state_changed');
  }
  async add(filenames: string[], reset: boolean, context: RpcContext, requestId?: string): Promise<Json> {
    if (!filenames.length || filenames.length > this.#maxJobs || typeof reset !== 'boolean' || requestId !== undefined && !validJournalId(requestId)) throw new ApiError(400, 'Invalid queue admission');
    const names = filenames.map(name => printFilename(name)), user = context.user?.username ?? null;
    const fingerprint = createHash('sha256').update(JSON.stringify([names, reset, user])).digest('hex');
    return this.#serialize(async () => {
      this.#assertWritable(); context.signal.throwIfAborted();
      const receipt = requestId === undefined ? undefined : this.#catalogue.receipts.find(r => r.id === requestId);
      if (receipt) { if (receipt.fingerprint !== fingerprint) throw new ApiError(409, 'Queue request identity already used'); return this.status; }
      if (reset && this.#catalogue.claim) throw new ApiError(409, 'Queue print admission is pending');
      if ((reset ? 0 : this.#catalogue.jobs.length) + names.length > this.#maxJobs) throw new ApiError(413, 'Job queue is full');
      const signal = AbortSignal.any([context.signal, this.#lifetime.signal]);
      const jobs: QueuedNativeJob[] = [];
      for (const filename of names) {
        signal.throwIfAborted(); const fileId = await this.#options.resolveFile(filename, signal);
        if (!validJournalId(fileId)) throw new ApiError(502, 'Invalid queue file identity');
        await context.authorize('printer.print.start', { filename, file_id: fileId }); signal.throwIfAborted();
        jobs.push({ job_id: randomBytes(8).toString('hex').toUpperCase(), filename, file_id: fileId, time_added: Date.now() / 1000, user });
      }
      const next = structuredClone(this.#catalogue); next.jobs = [...reset ? [] : next.jobs, ...jobs];
      if (new Set(next.jobs.map(job => job.job_id)).size !== next.jobs.length) throw new ApiError(503, 'Queue identity collision');
      if (requestId !== undefined) next.receipts = [...next.receipts, { id: requestId, fingerprint, jobs: jobs.map(job => job.job_id) }].slice(-64);
      const active = this.#options.automaticTransition && !this.#pauseRequested ? this.#options.activePrint!() : undefined;
      const authority = active && !this.#continuation ? this.#options.captureAuthority!(context, this.#lifetime.signal) : undefined;
      // Validate the ephemeral authority before committing any queue members.
      authority?.signal.throwIfAborted(); authority?.nativeGenerationSignal?.throwIfAborted();
      if (authority && (!authority.nativeGenerationSignal || authority.nativeGenerationRetiredAtAdmission)) throw new ApiError(503, 'Automatic queue requires an attached device generation');
      signal.throwIfAborted(); await this.#commit(next, 'jobs_added');
      if (this.#options.automaticTransition && !this.#pauseRequested) {
        if (active && this.#options.activePrint!()?.requestId === active.requestId) {
          if (!this.#continuation && authority && !authority.signal.aborted && !authority.nativeGenerationSignal!.aborted) this.#arm(authority, active.requestId);
          if (this.#continuation?.requestId === active.requestId) this.#setState('ready');
        }
      }
      return this.status;
    });
  }
  remove(ids: string[], all: boolean, context: RpcContext): Promise<Json> {
    if (!Array.isArray(ids) || ids.length > this.#maxJobs || ids.some(id => typeof id !== 'string') || typeof all !== 'boolean') throw new ApiError(400, 'Invalid queue deletion');
    return this.#serialize(async () => {
      context.signal.throwIfAborted(); const claim = this.#catalogue.claim;
      if (claim && (all || ids.includes(claim.job_id))) throw new ApiError(409, 'Print admission owns this queue member');
      const next = structuredClone(this.#catalogue);
      next.jobs = all ? [] : next.jobs.filter(job => !ids.includes(job.job_id));
      if (next.jobs.length !== this.#catalogue.jobs.length) await this.#commit(next, 'jobs_removed');
      if (!next.jobs.length) { this.#disarm(); this.#setState('paused'); }
      return this.status;
    });
  }
  jump(id: string, context: RpcContext): Promise<Json> {
    return this.#serialize(async () => {
      context.signal.throwIfAborted(); if (this.#catalogue.claim) throw new ApiError(409, 'Queue print admission is pending');
      const job = this.#catalogue.jobs.find(job => job.job_id === id); if (!job) throw new ApiError(400, 'Invalid job id: ' + id);
      const next = structuredClone(this.#catalogue); next.jobs = [job, ...next.jobs.filter(job => job.job_id !== id)];
      await this.#commit(next, 'jobs_reordered'); return this.status;
    });
  }
  async pause(): Promise<Json> {
    this.#pause++; this.#pauseRequested = true; this.#disarm(); this.#setState('paused');
    await this.#dispatch; await this.#tail;
    return this.status;
  }
  async start(context: RpcContext, token?: string): Promise<Json> {
    if (!this.#options.confirmClearance) {
      if (token !== undefined) throw new ApiError(400, 'Queue confirmation is not configured');
      return this.#start(context, false);
    }
    if (token === undefined) {
      // Starting while an existing job owns the device only arms its matching
      // completion. A fresh confirmation is requested after durable completion.
      if (!this.#options.canStart()) return this.#start(context, false);
      const authority = this.#options.captureAuthority!(context, this.#lifetime.signal);
      return this.#requestConfirmation(authority, null);
    }
    if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) throw new ApiError(400, 'Invalid queue confirmation token');
    const clearance = this.#clearance;
    if (!clearance || clearance.token !== token) throw new ApiError(409, 'Queue confirmation changed; refresh status');
    if (performance.now() >= clearance.deadline) { this.#disarm(); throw new ApiError(410, 'Queue confirmation expired'); }
    context.signal.throwIfAborted(); clearance.context.signal.throwIfAborted();
    if (context.nativeGenerationRetiredAtAdmission || context.nativeGenerationSignal !== clearance.context.nativeGenerationSignal) throw new ApiError(503, 'Queue confirmation belongs to another device generation');
    if (context.user?.username !== clearance.context.user?.username) throw new ApiError(403, 'Queue confirmation belongs to another operator');
    // A current login cannot silently replace the initiating principal's revoked
    // grant. A new explicit challenge can be requested with fresh authority.
    try { await clearance.context.authorize('printer.print.start', { filename: clearance.job.filename, file_id: clearance.job.file_id }); }
    catch (error) { if (this.#clearance === clearance) { this.#disarm(); this.#transitionError = 'Queue confirmation authority revoked; request a fresh confirmation'; this.#setState('paused'); this.#emit(); } throw error; }
    await context.authorize('printer.print.start', { filename: clearance.job.filename, file_id: clearance.job.file_id });
    if (this.#clearance !== clearance || performance.now() >= clearance.deadline) throw new ApiError(409, 'Queue confirmation changed during authorization');
    return this.#start(context, false, clearance);
  }
  async #requestConfirmation(context: RpcContext, completedRequestId: string | null): Promise<Json> {
    const pause = this.#pause;
    return this.#serialize(async () => {
      context.signal.throwIfAborted(); context.nativeGenerationSignal?.throwIfAborted();
      if (context.nativeGenerationRetiredAtAdmission || !context.nativeGenerationSignal) throw new ApiError(503, 'Queue confirmation requires an attached device generation');
      if (pause !== this.#pause || !this.#catalogue.jobs.length || !this.#options.canStart()) return this.status;
      const job = this.#catalogue.jobs[0], signal = AbortSignal.any([context.signal, this.#lifetime.signal]);
      const identity = await this.#options.resolveFile(job.filename, signal);
      if (identity !== job.file_id) throw new ApiError(409, 'Queued file has been replaced');
      await context.authorize('printer.print.start', { filename: job.filename, file_id: job.file_id }); signal.throwIfAborted();
      if (pause !== this.#pause || !this.#options.canStart()) return this.status;
      this.#disarm(); this.#transitionError = null;
      const duration = this.#options.confirmationTimeoutMs ?? 300000;
      const invalidate = () => { if (this.#clearance === clearance) { this.#clearConfirmation(); this.#transitionError = 'Queue confirmation expired or device authority retired'; this.#setState('paused'); this.#emit(); } };
      const timer = setTimeout(invalidate, duration); timer.unref();
      const clearance: Clearance = { token: randomBytes(16).toString('hex'), revision: this.#catalogue.revision, job: { ...job }, completedRequestId,
        expiresAt: Date.now() + duration, deadline: performance.now() + duration, context, timer, removeAbort: () => signal.removeEventListener('abort', invalidate) };
      this.#clearance = clearance; signal.addEventListener('abort', invalidate, { once: true });
      this.#setState('paused'); this.#emit(); return this.status;
    });
  }
  async #start(context: RpcContext, continuation: boolean, clearance?: Clearance): Promise<Json> {
    this.#assertWritable(); context.signal.throwIfAborted();
    if (context.nativeGenerationRetiredAtAdmission) throw new ApiError(503, 'Queue start entered a detached device window');
    if (this.#dispatch) return this.status;
    let authority = context;
    if (!continuation) {
      if (this.#options.automaticTransition) {
        authority = this.#options.captureAuthority!(context, this.#lifetime.signal);
        context = { ...context, user: authority.user, authorize: authority.authorize };
      }
      this.#pauseRequested = false;
      this.#disarm(); this.#transitionError = null;
    }
    const pause = this.#pause;
    const signal = AbortSignal.any([context.signal, this.#lifetime.signal, ...context.nativeGenerationSignal ? [context.nativeGenerationSignal] : [], ...clearance ? [AbortSignal.timeout(Math.max(1, Math.ceil(clearance.deadline - performance.now())))] : []]);
    const dispatch = this.#serialize(async () => {
      signal.throwIfAborted(); if (pause !== this.#pause || !this.#catalogue.jobs.length) return;
      if (clearance && (clearance.revision !== this.#catalogue.revision || this.#catalogue.jobs[0].job_id !== clearance.job.job_id || this.#catalogue.jobs[0].file_id !== clearance.job.file_id)) throw new ApiError(409, 'Confirmed queue head changed before admission');
      if (!this.#options.canStart()) {
        const active = this.#options.automaticTransition ? this.#options.activePrint!() : undefined;
        if (active && !continuation) { this.#arm(authority, active.requestId); this.#setState('ready'); }
        return;
      }
      if (this.#options.confirmClearance && !clearance) throw new ApiError(409, 'Queue became idle; request a fresh clearance confirmation');
      if (this.#catalogue.claim) throw new ApiError(503, 'Queue admission awaits journal recovery');
      const job = this.#catalogue.jobs[0]; this.#setState('loading');
      try {
        const identity = await this.#options.resolveFile(job.filename, signal);
        if (identity !== job.file_id) throw new ApiError(409, 'Queued file has been replaced');
        await context.authorize('printer.print.start', { filename: job.filename, file_id: job.file_id }); signal.throwIfAborted();
        if (pause !== this.#pause || !this.#options.canStart()) return;
        const next = structuredClone(this.#catalogue), requestId = 'queue-' + randomUUID();
        next.claim = { job_id: job.job_id, request_id: requestId, file_id: job.file_id };
        await this.#commit(next, 'state_changed');
        // A pause during the catalogue transaction prevents device admission.
        if (pause === this.#pause && !signal.aborted && !this.#closing) {
          this.#setState('starting');
          // Arm before admission: an immediate durable completion must not be
          // lost while start() or catalogue recovery is still pending.
          if (this.#options.automaticTransition) this.#arm(authority, requestId);
          await this.#options.start(Object.freeze({ ...job }), requestId, { ...context, signal });
          const record = await this.#options.journal.get(requestId);
          if (!record || record.request.fileId !== job.file_id) throw new ApiError(502, 'Queue start did not reserve the matching print request');
        }
      } catch (error) { this.#disarm(); throw error; }
      finally {
        try { if (!this.#storageFailed && !this.#closing) await this.#recover(); }
        catch (error) { this.#disarm(); this.#setState('paused'); throw error; }
        this.#setState(this.#continuation && this.#catalogue.jobs.length ? 'ready' : 'paused');
      }
    });
    this.#dispatch = dispatch;
    try { await dispatch; } finally {
      if (this.#dispatch === dispatch) this.#dispatch = undefined;
      if (this.#continuation?.finished) this.#schedule(this.#continuation);
    }
    return this.status;
  }
  close(): Promise<void> {
    if (this.#closed) return this.#closed;
    this.#closing = true; this.#pause++; this.#disarm(); this.#releaseHistory?.(); this.#lifetime.abort(new Error('Job queue closed')); this.#state = 'paused';
    return this.#closed = (async () => { await Promise.allSettled([this.#automaticTask, this.#dispatch, this.#tail]); await this.#notifications; owners.delete(this.#options.database); })();
  }
}
/** Registration shares the real REST/RPC authorizer. No raw device command or
 * user identity parameter can be accepted through the queue endpoints. */
export function registerNativeJobQueue(registry: EndpointRegistry, queue: NativeJobQueue): () => void {
  const releases: (() => void)[] = [];
  const allowed = (params: Readonly<Record<string, Json>>, keys: string[]) => { if (Object.keys(params).some(key => !keys.includes(key))) throw new ApiError(400, 'Unexpected queue argument'); };
  try {
    releases.push(registry.register({ endpoint: '/server/job_queue/status', methods: ['GET'] }, params => { allowed(params, []); return queue.status; }));
    releases.push(registry.register({ endpoint: '/server/job_queue/job', methods: ['POST', 'DELETE'] }, (params, verb, context) => {
      allowed(params, verb === 'POST' ? ['filenames', 'reset', 'request_id'] : ['job_ids', 'all']);
      if (verb === 'POST') {
        if (params.request_id !== undefined && typeof params.request_id !== 'string') throw new ApiError(400, 'Invalid queue request_id');
        return queue.add(list(params.filenames, 'filenames'), historyBoolean(params.reset), context, params.request_id);
      }
      const all = historyBoolean(params.all); return queue.remove(all ? [] : list(params.job_ids, 'job_ids'), all, context);
    }));
    releases.push(registry.register({ endpoint: '/server/job_queue/jump', methods: ['POST'] }, (params, _verb, context) => {
      allowed(params, ['job_id']);
      if (typeof params.job_id !== 'string') throw new ApiError(400, 'Missing queue job_id'); return queue.jump(params.job_id, context);
    }));
    releases.push(registry.register({ endpoint: '/server/job_queue/pause', methods: ['POST'] }, params => { allowed(params, []); return queue.pause(); }));
    releases.push(registry.register({ endpoint: '/server/job_queue/start', methods: ['POST'] }, (params, _verb, context) => { allowed(params, ['transition_token']); if (params.transition_token !== undefined && typeof params.transition_token !== 'string') throw new ApiError(400, 'Invalid queue confirmation token'); return queue.start(context, params.transition_token); }));
  } catch (error) { for (const undo of releases.reverse()) undo(); throw error; }
  return () => { for (const undo of releases.reverse()) undo(); };
}
