import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {setImmediate} from 'node:timers/promises';
import {queuePanelScript} from '../src/runtime/product-queue-panel.ts';

// A minimal browser event/transport harness, not rendered-page acceptance.
// Run the shipped script, observe actual requests, and control reply ordering.
class Element {
  textContent = ''; hidden = false; disabled = false; checked = false;
  children: Element[] = []; attributes = new Map<string, string>();
  listeners = new Map<string, (() => void)[]>(); replacements = 0;
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], callback]); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  replaceChildren(...children: Element[]) { this.children = children; this.replacements++; }
  fire(name: string) { for (const callback of this.listeners.get(name) ?? []) callback(); }
  set innerHTML(_value: string) { throw new Error('User data must never become HTML'); }
}
type Queue = { queue_state: string; queued_jobs: { job_id: string; filename: string }[]; transition?: object | null };
const queue = (token?: string, filename = '零件 % 01.gcode'): Queue => ({ queue_state: 'paused', queued_jobs: [{ job_id: 'ONE', filename }], transition: token ? { version: 1, phase: 'awaiting_confirmation', state_token: token, job_id: 'ONE', filename, expires_at: Date.now() + 300000 } : null });
const first = 'a'.repeat(32), second = 'b'.repeat(32);
const reply = (status: number, value?: unknown) => ({ status, ok: status >= 200 && status < 300, async json() { return JSON.parse(JSON.stringify(value)); } });
async function settle() { for (let i = 0; i < 5; i++) await setImmediate(); }
function fixture(fetch: (path: string, init: RequestInit) => Promise<ReturnType<typeof reply>>) {
  const ids = ['queue-cleared', 'queue-confirm', 'queue-prepare', 'queue-pause', 'queue-refresh', 'queue-error', 'queue-operation', 'queue-state', 'queue-file', 'queue-guidance', 'queue-expiry', 'queue-list', 'queue-empty'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  for (const id of ['queue-cleared', 'queue-confirm', 'queue-prepare', 'queue-pause']) elements[id].disabled = true;
  const documentEvents = new Map<string, (() => void)[]>(), windowEvents = new Map<string, ((event: object) => void)[]>();
  const requests: { path: string; init: RequestInit }[] = [], redirects: string[] = [];
  let polling: (() => void) | undefined, reloads = 0;
  const document = { visibilityState: 'visible', getElementById: (id: string) => elements[id], createElement: () => new Element(), addEventListener(name: string, callback: () => void) { documentEvents.set(name, [...documentEvents.get(name) ?? [], callback]); } };
  const window = { document, async fetch(path: string, init: RequestInit) { requests.push({ path, init }); return fetch(path, init); }, location: { replace(path: string) { redirects.push(path); }, reload() { reloads++; } }, setInterval(callback: () => void, ms: number) { assert.equal(ms, 1000); polling = callback; return 1; }, clearInterval() { polling = undefined; }, addEventListener(name: string, callback: (event: object) => void) { windowEvents.set(name, [...windowEvents.get(name) ?? [], callback]); } };
  runInNewContext(queuePanelScript(), { window, AbortController, AbortSignal });
  return { elements, requests, redirects, async poll() { polling?.(); await settle(); }, async visibility(value: string) { document.visibilityState = value; for (const fn of documentEvents.get('visibilitychange') ?? []) fn(); await settle(); }, async event(name: string, value = {}) { for (const fn of windowEvents.get(name) ?? []) fn(value); await settle(); }, reloads: () => reloads };
}

test('shipped browser script only starts after explicit clearance and blocks double activation', async () => {
  let state = queue(), admissions = 0;
  const f = fixture(async (path, init) => {
    assert.equal(init.credentials, 'same-origin');
    if (init.method === 'POST') {
      assert.equal(path, '/server/job_queue/start'); const body = JSON.parse(String(init.body));
      if (body.transition_token) { assert.equal(body.transition_token, first); admissions++; state = { queue_state: 'paused', queued_jobs: [], transition: null }; }
      else { assert.deepEqual(body, { request_confirmation: true }); state = queue(first); }
    }
    return reply(200, { result: state });
  });
  await settle(); assert.equal(f.elements['queue-prepare'].disabled, false); assert.equal(admissions, 0);
  f.elements['queue-prepare'].fire('click'); await settle();
  assert.equal(f.elements['queue-confirm'].disabled, true); assert.equal(admissions, 0);
  f.elements['queue-cleared'].checked = true; f.elements['queue-cleared'].fire('change');
  f.elements['queue-confirm'].fire('click'); f.elements['queue-confirm'].fire('click'); await settle();
  assert.equal(admissions, 1); assert.equal(f.requests.filter(r => r.init.method === 'POST').length, 2);
  assert.match(f.elements['queue-state'].textContent, /确认已提交/); assert.equal(f.elements['queue-cleared'].checked, false);
  assert(!f.elements['queue-state'].textContent.includes('已完成打印'));
});

test('missing operator policy never falls back to ordinary unconfirmed queue start', async () => {
  const state = queue(); delete state.transition;
  const f = fixture(async () => reply(200, { result: state })); await settle();
  f.elements['queue-prepare'].fire('click'); f.elements['queue-confirm'].fire('click'); await f.poll();
  assert.equal(f.requests.filter(r => r.init.method === 'POST').length, 0);
  assert.equal(f.elements['queue-confirm'].disabled, true); assert.match(f.elements['queue-guidance'].textContent, /未启用/);
});

test('a changed or old server rejects explicit confirmation intent without an empty-body fallback', async () => {
  const f = fixture(async (_path, init) => {
    if (init.method === 'POST') { assert.deepEqual(JSON.parse(String(init.body)), { request_confirmation: true }); return reply(400, { error: { message: 'Confirmation not configured or unsupported' } }); }
    return reply(200, { result: queue() });
  });
  await settle(); f.elements['queue-prepare'].fire('click'); await settle(); await f.poll();
  assert.equal(f.requests.filter(r => r.init.method === 'POST').length, 1); assert.equal(f.elements['queue-error'].hidden, false);
  assert.equal(f.elements['queue-confirm'].disabled, true); assert.equal(f.elements['queue-cleared'].checked, false);
});

test('new confirmation clears checkbox and user filenames remain text; unchanged list stays stable', async () => {
  const filename = '长目录/'.repeat(40) + '<img src=x onerror=alert(1)> % 零件.gcode'; let state = queue(first, filename);
  const f = fixture(async () => reply(200, { result: state })); await settle();
  f.elements['queue-cleared'].checked = true; f.elements['queue-cleared'].fire('change'); const replacements = f.elements['queue-list'].replacements;
  await f.poll(); assert.equal(f.elements['queue-list'].replacements, replacements); assert.equal(f.elements['queue-confirm'].disabled, false);
  state = queue(second, filename); await f.poll(); assert.equal(f.elements['queue-cleared'].checked, false); assert.equal(f.elements['queue-confirm'].disabled, true);
  assert.equal(f.elements['queue-list'].children[0].textContent, filename); assert.equal(f.elements['queue-file'].textContent, filename);
});

test('ambiguous mutation response is not retried and warning survives readonly polling', async () => {
  const f = fixture(async (_path, init) => { if (init.method === 'POST') throw new Error('Connection lost after possible admission'); return reply(200, { result: queue(first) }); }); await settle();
  f.elements['queue-cleared'].checked = true; f.elements['queue-cleared'].fire('change'); f.elements['queue-confirm'].fire('click'); await settle(); await f.poll();
  assert.equal(f.requests.filter(r => r.init.method === 'POST').length, 1); assert.equal(f.elements['queue-cleared'].checked, false);
  assert.equal(f.elements['queue-error'].hidden, false); assert.match(f.elements['queue-error'].textContent, /不会自动重试/);
});

test('an old status response cannot overwrite a later explicit confirmation response', async () => {
  let reads = 0, release: ((value: ReturnType<typeof reply>) => void) | undefined;
  const held = new Promise<ReturnType<typeof reply>>(resolve => { release = resolve; });
  const f = fixture(async (_path, init) => init.method === 'POST' ? reply(200, { result: queue(second, 'new.gcode') }) : ++reads === 2 ? held : reply(200, { result: queue() })); await settle();
  void f.poll(); await settle(); f.elements['queue-prepare'].fire('click'); await settle();
  release!(reply(200, { result: queue(first, 'stale.gcode') })); await settle();
  assert.equal(f.elements['queue-file'].textContent, 'new.gcode'); assert.equal(f.elements['queue-cleared'].checked, false);
});

test('tab return requires fresh state and a response after pagehide cannot revive controls', async () => {
  let release: ((value: ReturnType<typeof reply>) => void) | undefined;
  const held = new Promise<ReturnType<typeof reply>>(resolve => { release = resolve; });
  const f = fixture(async (_path, init) => init.method === 'POST' ? held : reply(200, { result: queue(first) })); await settle();
  f.elements['queue-cleared'].checked = true; f.elements['queue-cleared'].fire('change'); await f.visibility('hidden');
  assert.equal(f.elements['queue-cleared'].checked, false); await f.visibility('visible');
  f.elements['queue-cleared'].checked = true; f.elements['queue-cleared'].fire('change'); f.elements['queue-confirm'].fire('click');
  await f.event('pagehide'); release!(reply(200, { result: queue(second) })); await settle();
  assert.equal(f.elements['queue-prepare'].disabled, true); assert.equal(f.elements['queue-cleared'].disabled, true);
  const count = f.requests.length; await f.poll(); assert.equal(f.requests.length, count); await f.event('pageshow', { persisted: true }); assert.equal(f.reloads(), 1);
});

test('mismatched response, disconnected read and expired login all close the page admission path', async () => {
  let mode = 0;
  const malformed = queue(first); (malformed.transition as { job_id: string }).job_id = 'ANOTHER';
  const f = fixture(async () => { if (mode === 1) throw new Error('Offline'); return mode === 2 ? reply(401) : reply(200, { result: malformed }); }); await settle();
  assert.equal(f.elements['queue-confirm'].disabled, true); assert.equal(f.elements['queue-error'].hidden, false);
  mode = 1; await f.poll(); assert.equal(f.elements['queue-prepare'].disabled, true);
  mode = 2; await f.poll(); assert.deepEqual(f.redirects, ['/_client/login']);
  const count = f.requests.length; await f.poll(); assert.equal(f.requests.length, count);
});

test('queue pause is an explicit single request and does not claim active print cancellation', async () => {
  const f = fixture(async (path, init) => { if (init.method === 'POST') { assert.equal(path, '/server/job_queue/pause'); assert.equal(init.body, '{}'); } return reply(200, { result: queue() }); }); await settle();
  f.elements['queue-pause'].fire('click'); f.elements['queue-pause'].fire('click'); await settle();
  assert.equal(f.requests.filter(r => r.init.method === 'POST').length, 1); assert.match(f.elements['queue-state'].textContent, /当前打印保持原状态/);
});
