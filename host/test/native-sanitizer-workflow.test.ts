import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parse} from 'yaml';
const host=fileURLToPath(new URL('..',import.meta.url));
const reference=JSON.parse(readFileSync(new URL('../contracts/native-sanitizer-command-reference.json',import.meta.url),'utf8')) as {timeoutMs:number;commands:string[][]};
function list(...args:string[]){
 const result=spawnSync(process.execPath,['scripts/test-native-sanitized.ts','--list',...args],{cwd:host,encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout) as {modes:string[];timeoutMs:number;commands:string[][]};
}
test('separate sanitizer modes retain every command from the successful original serial CI exactly once',()=>{
 const original=list(),ubsan=list('--mode=ubsan'),asan=list('--mode=asan');
 assert.deepEqual(original.commands,reference.commands);assert.deepEqual([...ubsan.commands,...asan.commands],reference.commands);
 assert.deepEqual(original.modes,['ubsan','asan']);assert.deepEqual(ubsan.modes,['ubsan']);assert.deepEqual(asan.modes,['asan']);
 for(const mode of [original,ubsan,asan])assert.equal(mode.timeoutMs,reference.timeoutMs);
 for(const mode of [ubsan,asan]){assert.equal(mode.commands.filter(c=>c[0]==='--test').length,150);assert.equal(mode.commands.filter(c=>c[0]!=='--test').length,7);}
});
test('invalid sanitizer selection fails before any build or test can run',()=>{
 for(const args of [['--mode=unknown'],['--mode='],['--mode=asan','--mode=ubsan'],['--mode'],['--address'],['--list','--mode=unknown']]){
  const result=spawnSync(process.execPath,['scripts/test-native-sanitized.ts',...args],{cwd:host,encoding:'utf8',timeout:10000});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Usage:/);assert(!result.stdout.includes('sanitizedCommand'));
 }
});
const workflow=parse(readFileSync(new URL('../../.github/workflows/node-host.yaml',import.meta.url),'utf8')) as any;
test('stable host check waits for ordinary checks and both independent sanitizer modes without error bypass',()=>{
 const {checks,sanitizers,host:gate}=workflow.jobs;
 assert.deepEqual(gate.needs,['checks','sanitizers']);assert.equal(gate.if,'${{ always() }}');
 assert.deepEqual(sanitizers.strategy.matrix.mode,['ubsan','asan']);assert.equal(sanitizers.strategy['fail-fast'],false);
 assert(sanitizers.steps.some((s:any)=>s.run==='npm run test:native-sanitized -- --mode=${{ matrix.mode }}'));
 const prepare=sanitizers.steps.findIndex((s:any)=>s.run==='npm run build:native'),execute=sanitizers.steps.findIndex((s:any)=>s.run==='npm run test:native-sanitized -- --mode=${{ matrix.mode }}');
 assert(prepare>sanitizers.steps.findIndex((s:any)=>s.run==='npm ci --ignore-scripts')&&prepare<execute,'independent sanitizer runner must build ordinary native prerequisites before original sanitized commands');
 for(const job of Object.values(workflow.jobs) as any[]){assert.notEqual(job['continue-on-error'],true);for(const step of job.steps)assert.notEqual(step['continue-on-error'],true);}
 for(const job of [checks,sanitizers])assert(job.steps.some((s:any)=>s.uses==='actions/setup-node@v4'&&s.with['node-version']==='26'));
 for(const command of ['npm ci --ignore-scripts','npm run typecheck','npm test','npm run test:protocol-native'])assert(checks.steps.some((s:any)=>s.run===command));
 assert(checks.steps.some((s:any)=>s.name==='Build Linux MCU with Node command generator'&&s.run.includes(' olddefconfig')&&s.run.includes(' all')));
});
test('host summary rejects failure, cancellation, skipped and absent prerequisite results',()=>{
 const step=workflow.jobs.host.steps[0];assert.equal(step.env.CHECKS_RESULT,'${{ needs.checks.result }}');assert.equal(step.env.SANITIZERS_RESULT,'${{ needs.sanitizers.result }}');
 for(const checks of ['success','failure','cancelled','skipped',''])for(const sanitizers of ['success','failure','cancelled','skipped','']){
  const result=spawnSync('/bin/bash',['--noprofile','--norc','-e','-o','pipefail','-c',step.run],{env:{...process.env,CHECKS_RESULT:checks,SANITIZERS_RESULT:sanitizers},encoding:'utf8',timeout:5000});
  assert.equal(result.status===0,checks==='success'&&sanitizers==='success',JSON.stringify({checks,sanitizers,status:result.status}));
 }
});
