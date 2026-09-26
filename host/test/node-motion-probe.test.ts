import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const cli=fileURLToPath(new URL('../scripts/diagnose-node-asan.ts',import.meta.url));
test('motion runtime probe verifies original reference in bounded fresh Node children and records source hashes',()=>{
 const run=spawnSync(process.execPath,[cli,'--case','motion','--asan','off','--runs','2','--workers','1'],{encoding:'utf8',timeout:30000,maxBuffer:1024**2,env:{...process.env,CC:'/nonexistent-compiler'}});
 const first=run.stdout.split('\n').find(line=>line.startsWith('{'));assert.ok(first,run.stderr);const {directory}=JSON.parse(first);
 try{assert.equal(run.status,0,run.stderr+'\n'+run.stdout);const report=JSON.parse(readFileSync(join(directory,'report.json'),'utf8'));assert.equal(report.kind,'motion');assert.equal(report.asan,'off');assert.deepEqual(report.addonHashes,{});assert.equal(report.results.length,2);
 assert.equal(report.jsOptimization,'default');assert.equal(report.runtime,undefined);assert.equal(report.runtimeSha256,undefined);assert.equal(report.args.length,1);
 for(const result of report.results){assert.equal(result.status,0);assert.equal(result.signal,null);assert.equal(result.stdout,'motion:loading\nmotion:loaded\nmotion:verified\n');}
 const source=readFileSync(new URL('../src/diagnostics/graph-motion.ts',import.meta.url));assert.equal(report.moduleHashes['src/diagnostics/graph-motion.ts'],createHash('sha256').update(source).digest('hex'));assert.equal(report.fixtureSha256,createHash('sha256').update(readFileSync(join(directory,'fixture.mjs'))).digest('hex'));
 const fixture=readFileSync(join(directory,'fixture.mjs'),'utf8'),injected=fixture.replace('const expected=r.curves[j];','const expected=r.curves[j];if(run===0&&i===0&&j===0)c.values[0]+=1;');assert.notEqual(fixture,injected);const path=join(directory,'injected.mjs');writeFileSync(path,injected);
 const failure=spawnSync(process.execPath,[path],{encoding:'utf8',timeout:10000});assert.equal(failure.status,1);assert.match(failure.stderr,/Error: Motion numerical mismatch /);const line=failure.stderr.split('\n').find(l=>l.startsWith('Error: Motion numerical mismatch '))!;const detail=JSON.parse(line.slice('Error: Motion numerical mismatch '.length));assert.equal(detail.actual,1);assert.equal(detail.expected,0);assert.equal(detail.repeated,0);assert.equal(detail.xor,'0x3ff0000000000000');assert.doesNotMatch(failure.stdout,/motion:verified/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('probe records explicit optimizing compiler controls without requiring a C compiler',()=>{
 const run=spawnSync(process.execPath,[cli,'--case','motion','--asan','off','--js-optimization','off','--runs','1','--workers','1'],{encoding:'utf8',timeout:30000,maxBuffer:1024**2,env:{...process.env,CC:'/nonexistent-compiler'}});
 const first=run.stdout.split('\n').find(line=>line.startsWith('{'));assert.ok(first,run.stderr);const {directory}=JSON.parse(first);
 try{assert.equal(run.status,0,run.stderr+'\n'+run.stdout);const report=JSON.parse(readFileSync(join(directory,'report.json'),'utf8'));assert.equal(report.jsOptimization,'off');assert.deepEqual(report.args.slice(0,2),['--no-maglev','--no-turbofan']);assert.equal(report.runtime,undefined);assert.equal(report.results[0].stdout,'motion:loading\nmotion:loaded\nmotion:verified\n');}finally{rmSync(directory,{recursive:true,force:true});}
});
test('probe rejects unbounded workers or runs before launching workloads',()=>{for(const args of [['--runs','1001'],['--workers','9'],['--js-optimization','unknown']]){const result=spawnSync(process.execPath,[cli,'--case','motion',...args],{encoding:'utf8',timeout:10000});assert.equal(result.status,1);assert.match(result.stderr,/Invalid diagnostic options/);assert.equal(result.stdout,'');}});
