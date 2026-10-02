import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseKlippyTest, runKlippyTest, type KlippyTestPlan} from '../src/diagnostics/klippy-test.ts';
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

test('all 37 legacy test files match 239 frozen Python snapshots', async () => {
  const contract = JSON.parse((await readFile(new URL('../contracts/klippy-test-retirement.json', import.meta.url), 'utf8')).replaceAll('$ROOT', root)) as {file: string; sha256: string; plans: KlippyTestPlan[]}[];
  assert.equal(contract.length, 37);
  let count = 0;
  for (const record of contract) {
    const source = await readFile(join(root, record.file), 'utf8');
    assert.equal(createHash('sha256').update(source).digest('hex'), record.sha256, record.file);
    assert.deepEqual(parseKlippyTest(source, join(root, record.file), join(root, 'dict')), record.plans, record.file);
    count += record.plans.length;
  }
  assert.equal(count, 239);
});

test('CONFIG snapshots, comments, CR newlines, multiple MCU dictionaries and invalid plans', () => {
  const plans = parseKlippyTest('CONFIG a\rDICTIONARY a.dict second=b.dict\rG1 X1 # comment\rCONFIG b\rG1 X2\rCONFIG c\rG1 X3', '/cases/input.test', '/dict');
  assert.deepEqual(plans.map(p => p.gcode), [['G1 X1'], ['G1 X1'], ['G1 X1', 'G1 X2']]);
  assert.deepEqual(plans[0]!.dictionaries, ['/dict/a.dict', 'second=/dict/b.dict']);
  for (const source of ['', 'CONFIG', 'CONFIG a', 'CONFIG a\nDICTIONARY a bad', 'CONFIG a\nDICTIONARY a\nGCODE x\nG1 X0'])
    assert.throws(() => parseKlippyTest(source, '/cases/t', '/dict'));
});

test('backend execution, isolated artifacts, expected errors, crashes, timeout and cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'klippy-runner-test-'));
  try {
    const backend = join(directory, 'fake backend.mjs');
    await writeFile(backend, `import {writeFileSync} from 'node:fs';
const a=process.argv.slice(2), mode=a[0];
const val=k=>a[a.indexOf(k)+1];
writeFileSync(val('-o')+'.mcu', JSON.stringify(a));
if(a.includes('-l')) writeFileSync(val('-l'),'diagnostic');
if(mode==='signal') process.kill(process.pid,'SIGKILL');
else if(mode==='wait') setInterval(()=>{},1000);
else process.exit(mode==='error'?2:0);
`);
    const sentinel = join(directory, '_test_output-unrelated');
    await writeFile(sentinel, 'untouched');
    const options = {executable: process.execPath, entrypoint: backend, cwd: root, tempdir: directory};
    const plan: KlippyTestPlan = {config: 'ok', dictionaries: ['/dict/a', 'mcu=/dict/b'], gcodeFile: null, gcode: ['G1 X2'], shouldFail: false};
    const cleaned = await runKlippyTest(plan, options);
    await assert.rejects(readFile(join(cleaned, '_test_.gcode')));
    const kept = await runKlippyTest(plan, {...options, keepfiles: true});
    assert.equal(await readFile(join(kept, '_test_.gcode'), 'utf8'), 'G1 X2\n');
    const args = JSON.parse(await readFile(join(kept, '_test_output.mcu'), 'utf8'));
    assert.deepEqual(args.slice(args.indexOf('-d')), ['-d', '/dict/a', '-d', 'mcu=/dict/b', '-l', join(kept, '_test_.log')]);
    await runKlippyTest({...plan, config: 'error', shouldFail: true}, options);
    await runKlippyTest({...plan, gcode: [], gcodeFile: '/external.gcode'}, {...options, verbose: true});
    await assert.rejects(runKlippyTest({...plan, shouldFail: true}, options), /failed to raise an error; artifacts:/);
    await assert.rejects(runKlippyTest({...plan, config: 'error'}, options), /exit 2\); artifacts:/);
    await assert.rejects(runKlippyTest({...plan, config: 'signal', shouldFail: true}, options), /SIGKILL; artifacts:/);
    await assert.rejects(runKlippyTest({...plan, config: 'wait', shouldFail: true}, {...options, timeoutMs: 100}), /timed out/);
    await assert.rejects(runKlippyTest({...plan, shouldFail: true}, {...options, executable: join(directory, 'missing')}), /ENOENT/);
    const controller = new AbortController();
    const running = runKlippyTest({...plan, config: 'wait', shouldFail: true}, {...options, signal: controller.signal});
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(running, /cancelled/);
    const before = await readdir(directory);
    await assert.rejects(runKlippyTest(plan, {...options, timeoutMs: 0}), /timeoutMs/);
    await assert.rejects(runKlippyTest(plan, {...options, signal: controller.signal}));
    assert.deepEqual(await readdir(directory), before);
    assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('CLI handles spaces, explicit backend, retained files and validates all files before execution', async () => {
  const {spawnSync} = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'klippy cli '));
  try {
    const backend = join(directory, 'backend.mjs'), filename = join(directory, 'case.test');
    await writeFile(backend, 'process.exit(0);\n');
    await writeFile(filename, 'CONFIG config.cfg\nDICTIONARY firmware.dict\nG1 X2\nCONFIG second.cfg\n');
    const cli = join(root, 'scripts/test_klippy.ts');
    const args = [cli, '--python', process.execPath, '--klippy', backend, '-t', directory, '-d', directory, '-k'];
    const invoke = (extra: string[]) => spawnSync(process.execPath, [...args, ...extra], {cwd: root, encoding: 'utf8', timeout: 10000});
    const success = invoke([filename]);
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stderr, /1 test files \(2 cases\) passed/);
    const before = await readdir(directory);
    assert.equal(before.filter(name => name.startsWith('klippy-test-')).length, 2);
    await writeFile(filename, 'CONFIG config.cfg\nDICTIONARY firmware.dict\n');
    const failure = invoke([filename, join(directory, 'missing.test')]);
    assert.equal(failure.status, 1);
    assert.deepEqual(await readdir(directory), before);
    assert.equal(invoke(['--timeout-ms', 'NaN', filename]).status, 1);
    assert.equal(invoke([]).status, 1);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
