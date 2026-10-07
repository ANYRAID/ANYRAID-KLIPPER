import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { ConfiguredMoonraker } from '../src/moonraker/configured-server.ts';
import { DatabaseStore } from '../src/moonraker/database.ts';
import { PrintJournal } from '../src/operations/print-journal.ts';
import { PrintController } from '../src/operations/print.ts';
import { MaintenanceGate } from '../src/operations/maintenance-gate.ts';
import { NativePrintUploads } from '../src/moonraker/native-print-uploads.ts';
import { PublishedPrintFiles } from '../src/storage/published-files.ts';

test('configured process queue shares published files, print admission, history, private identity and authorized notifications', async () => {
  const root = await mkdtemp(join(tmpdir(), 'configured-native-queue-')), config = join(root, 'moonraker.conf');
  await writeFile(config, '[server]\nhost=127.0.0.1\nport=0\n[job_queue]\n');
  const database = await DatabaseStore.open({ path: join(root, 'moonraker.db') });
  const journal = await PrintJournal.open({ path: join(root, 'prints.db'), deviceId: 'queue-printer' });
  const files = await PublishedPrintFiles.open(join(root, 'files')), gate = new MaintenanceGate();
  const processFiles = await NativePrintUploads.open(files, gate, { stagingRoot: root, metadataRoot: join(root, 'metadata') });
  const deviceFiles = new NativePrintUploads(files, gate, { stagingRoot: root }, processFiles);
  const commands: string[] = [];
  const controller = new PrintController({ async prepare(r) { commands.push('prepare:' + r.requestId); }, async start(id) { commands.push('start:' + id); }, async pause() {}, async resume() {}, async finish() {}, async stop() {} }, { maxNozzle: 300, maxBed: 120 }, {}, { journal, maintenanceGate: gate });
  let server: ConfiguredMoonraker | undefined, socket: WebSocket | undefined;
  const notifications: any[] = [];
  try {
    await writeFile(join(root, 'source.gcode'), 'G1 X1 F600\n'); const source = await open(join(root, 'source.gcode'), 'r');
    try { await files.publish('one', 'one.gcode', source, new AbortController().signal); } finally { await source.close(); }
    server = await ConfiguredMoonraker.loadAuthorized(config, {
      information: { connected: false, state: 'disconnected', components: [], failedComponents: [], directories: [], warnings: [], version: 'queue-test', missingRequirements: [] },
      database, authorization: { issuer: 'https://queue.invalid' }, productPrint: controller, maintenanceGate: gate,
      nativeUploads: deviceFiles, nativeProcessFiles: processFiles, nativeProcessHistory: journal,
      productPrintCompatibility: { async start(filename, signal) { return { fileId: await processFiles.resolveQueuedFile(filename, signal), nozzle: 0, bed: 0 }; } },
      nativeHost: () => ({ group_state: 'ready', hardware_state: 'ready', print_state: controller.state, homed_axes: '', closing: false, admission_closed: gate.status.closed, maintenance: false, mcus: [{ id: 'simulated-status', state: 'ready' }] }),
      nativePrinterIdentity: { configFile: join(root, 'printer.cfg'), softwareVersion: 'queue-test' },
    });
    const { port } = await server.start(), base = `http://127.0.0.1:${port}`, headers = { 'x-api-key': server.authorization!.localApiKey(), 'content-type': 'application/json' };
    socket = new WebSocket(`ws://127.0.0.1:${port}/websocket`, { headers }); socket.on('message', raw => notifications.push(JSON.parse(raw.toString()))); await once(socket, 'open');
    const call = async (path: string, method = 'GET', body?: object) => {
      const response = await fetch(base + path, { method, headers, ...body ? { body: JSON.stringify(body) } : {} });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value.result;
    };
    assert.equal((await fetch(base + '/server/job_queue/status')).status, 401);
    const information = await call('/server/info'); assert(information.components.includes('job_queue'));
    const added = await call('/server/job_queue/job', 'POST', { filenames: ['one.gcode', 'one.gcode'], request_id: 'add-once' });
    assert.equal(added.queued_jobs.length, 2); assert.equal(commands.length, 0);
    await call('/server/job_queue/start', 'POST'); assert.equal(controller.state, 'printing');
    const request = controller.currentRequest!; assert.match(request.requestId, /^queue-/); assert.equal(request.fileId, 'one');
    const queued = await call('/server/job_queue/status'); assert.equal(queued.queued_jobs.length, 1);
    const history = await call('/server/history/list'); assert.equal(history.jobs.length, 1); assert.equal(history.jobs[0].metadata.native_request_id, request.requestId);
    await call('/server/job_queue/pause', 'POST'); assert.equal(controller.state, 'printing');
    assert.equal((await fetch(base + '/server/database/item?namespace=native_job_queue&key=catalogue', { headers })).status, 403);
    const until = performance.now() + 3000;
    while (!notifications.some(n => n.method === 'notify_job_queue_changed' && n.params[0].action === 'job_loaded')) { assert(performance.now() < until, 'Missing authorized queue notification'); await delay(5); }
    const event = notifications.find(n => n.method === 'notify_job_queue_changed' && n.params[0].action === 'job_loaded');
    assert.equal(event.params[0].updated_queue.length, 1); assert.equal(JSON.stringify(event).includes('file_id'), false);
    await controller.complete(request.requestId);
    await server.retireNativePrinter();
    await call('/server/job_queue/job', 'POST', { filenames: ['one.gcode'] });
    assert.equal((await call('/server/job_queue/status')).queued_jobs.length, 2);
    const offlineStart = await fetch(base + '/server/job_queue/start', { method: 'POST', headers }); assert.equal(offlineStart.status, 503); await offlineStart.arrayBuffer();
    await call('/server/job_queue/job?all=true', 'DELETE'); assert.equal((await call('/server/job_queue/status')).queued_jobs.length, 0);
    assert.equal(commands.filter(c => c.startsWith('start:')).length, 1);
  } finally { socket?.terminate(); await server?.close(); await deviceFiles.drain(); await processFiles.drain(); await files.close(); await journal.close(); await database.close(); await rm(root, { recursive: true, force: true }); }
});

for (const option of ['automatic_transition=true', 'load_on_startup=true', 'job_transition_gcode=G1 X10', 'job_transition_policy=operator_confirmation', 'job_transition_policy=unknown', 'job_transition_gcode=PAUSE\njob_transition_policy=none', 'job_transition_confirmation_timeout=901']) test('unsupported or unowned queue operation fails startup before device effects: ' + option, async () => {
  const root = await mkdtemp(join(tmpdir(), 'configured-queue-policy-')), config = join(root, 'moonraker.conf');
  await writeFile(config, '[server]\nhost=127.0.0.1\nport=0\n[job_queue]\n' + option + '\n');
  const database = await DatabaseStore.open({ path: join(root, 'moonraker.db') }), journal = await PrintJournal.open({ path: join(root, 'prints.db'), deviceId: 'queue-printer' });
  const files = await PublishedPrintFiles.open(join(root, 'files')), gate = new MaintenanceGate(), processFiles = await NativePrintUploads.open(files, gate, { stagingRoot: root, metadataRoot: join(root, 'metadata') });
  const deviceFiles = new NativePrintUploads(files, gate, { stagingRoot: root }, processFiles);
  let deviceEffects = 0;
  const controller = new PrintController({ async prepare() { deviceEffects++; }, async start() { deviceEffects++; }, async pause() {}, async resume() {}, async finish() {}, async stop() {} }, { maxNozzle: 300, maxBed: 120 }, {}, { journal, maintenanceGate: gate });
  try {
    const load = (options: Parameters<typeof ConfiguredMoonraker.loadAuthorized>[1]) => ['automatic_transition=true', 'job_transition_policy=operator_confirmation'].includes(option) ? ConfiguredMoonraker.load(config, { ...options, authorize: () => ({ username: 'operator' }) }) : ConfiguredMoonraker.loadAuthorized(config, options);
    await assert.rejects(load({
      information: { connected: false, state: 'disconnected', components: [], failedComponents: [], directories: [], warnings: [], version: 'queue-test', missingRequirements: [] },
      database, authorization: { issuer: 'https://queue.invalid' }, productPrint: controller, maintenanceGate: gate,
      nativeUploads: deviceFiles, nativeProcessFiles: processFiles, nativeProcessHistory: journal,
    }), option.includes('unknown') || option.includes('policy=none') ? /Invalid native queue transition policy/ : option.endsWith('=901') ? /confirmation timeout/ : /explicit product operation provider|process authorization owner/);
    assert.equal(deviceEffects, 0); assert.equal(database.status.closed, true);
    assert.equal(deviceFiles.status.closed, true); assert.equal(processFiles.status.closed, true);
    assert.deepEqual(await journal.historyList({ limit: 10 }), []);
  } finally { await deviceFiles.drain(); await processFiles.drain(); await files.close(); await journal.close(); await database.close(); await rm(root, { recursive: true, force: true }); }
});
