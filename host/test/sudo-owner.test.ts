import test from 'node:test';
import assert from 'node:assert/strict';
import {ProcessSudoOwner} from '../src/moonraker/sudo-owner.ts';
import {runOwnedSudo,type SudoBackend,type SudoInstallReceipt} from '../src/moonraker/sudo-backend.ts';
import type {RpcContext} from '../src/moonraker/rpc.ts';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const receipt:SudoInstallReceipt={schema:1,phase:'unknown',candidateSha256:'a'.repeat(64),unitSha256:'b'.repeat(64),backup:null,envBackup:null};
function context(signal=new AbortController().signal):RpcContext{return {transport:'http',signal,authorize(){return {username:'operator'};},afterResponse(){}};}
test('real FIFO consumer results retain restart demand across mixed failure and response retry',async()=>{
 const calls:string[]=[],events:unknown[]=[],backend:SudoBackend={async execute(){return receipt;},async close(){}};let failure=true,restarts=0;
 const owner=new ProcessSudoOwner(backend,e=>events.push(e),async()=>{restarts++;});owner.register('A','first',async()=>{calls.push('A');return {message:'A completed',restart:true};});owner.register('B','second',async()=>{calls.push('B');if(failure)throw Error('failed');return {message:'B completed',restart:false};});
 try{await assert.rejects(owner.setPassword('fixture-password',context()),/callback failed/);assert.deepEqual(calls,['A','B']);assert.equal(restarts,0);assert.equal(owner.snapshot.restart_required,true);failure=false;const result=await owner.setPassword('replacement-password',context()) as any;assert.equal(result.is_restarting,true);assert.deepEqual(calls,['A','B','B']);assert.equal(restarts,1);assert.equal(owner.snapshot.restart_required,true);assert(events.length>=4);assert(!JSON.stringify(owner).includes('password'));}finally{await owner.close();}
});
test('authorization revocation after probe prevents callbacks; cancellation keeps uncompleted callback',async()=>{
 const backend:SudoBackend={async execute(){return receipt;},async close(){}},owner=new ProcessSudoOwner(backend,()=>{},async()=>{});let runs=0,checks=0;owner.register('install','requires password',async()=>{runs++;return {message:'done',restart:true};});
 try{await assert.rejects(owner.setPassword('one', {...context(),authorize(){if(++checks>=2)throw Error('revoked');return {username:'operator'};}}),/revoked/);assert.equal(runs,0);assert.equal(owner.snapshot.sudo_requested,true);const stop=new AbortController();owner.register('cancel','cancelled consumer',async()=>{stop.abort();throw Error('cancel');});await assert.rejects(owner.setPassword('two',context(stop.signal)));assert.equal(owner.snapshot.request_messages.includes('cancelled consumer'),true);}finally{await owner.close();}
});
test('concurrent probes use bounded independent password snapshots, shutdown joins backend',async()=>{
 const entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>(),copies:Buffer[]=[],backend:SudoBackend={async execute(_op,password){if(password)copies.push(Buffer.from(password));if(copies.length===2){entered.resolve();await finish.promise;}return receipt;},async close(){}};
 const owner=new ProcessSudoOwner(backend,()=>{},async()=>{});try{await owner.setPassword('old-password',context());const probe=owner.info(true,new AbortController().signal);await entered.promise;await owner.setPassword('new-password',context());assert.equal(copies[1].toString(),'old-password');finish.resolve();await probe;assert.equal(copies[2].toString(),'new-password');}finally{finish.resolve();await owner.close();}
});
test('actual same-uid subprocess cancellation uses stdin EOF, waits close, preserves protocol boundary',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sudo-eof-')),ready=join(root,'ready'),done=join(root,'done'),stop=new AbortController(),code=`const fs=require('node:fs');fs.writeFileSync(process.argv[1],'ready');process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>fs.writeFileSync(process.argv[2],'EOF joined'),20));`;
 const task=runOwnedSudo(process.execPath,['-e',code,ready,done],Buffer.from('fixture-password'),stop.signal,3000);void task.catch(()=>{});
 try{let observed=false;for(let i=0;i<100;i++){try{observed=(await readFile(ready,'utf8'))==='ready';if(observed)break;}catch{}await new Promise(r=>setTimeout(r,10));}assert(observed,'actual child must start before cancellation');stop.abort();await assert.rejects(task,/unavailable/);assert.equal(await readFile(done,'utf8'),'EOF joined');}finally{stop.abort();await task.catch(()=>{});await rm(root,{recursive:true,force:true});}
});
test('authorization identity refresh and failed response handoff preserve an explicit restart retry',async()=>{
 const owner=new ProcessSudoOwner({async execute(){return receipt;},async close(){}},()=>{},async()=>{throw Error('handoff lost');});let username='';owner.register('installer','install',async c=>{username=c.user?.username??'';return {message:'installed',restart:true};});
 try{await assert.rejects(owner.setPassword('fixture-password',{...context(),user:{username:'stale'},authorize(){return {username:'fresh'};}}),/handoff lost/);assert.equal(username,'fresh');assert.equal(owner.snapshot.restart_required,true);assert.equal(owner.snapshot.sudo_requested,true);await assert.rejects(owner.setPassword('retry',context()),/handoff lost/);assert.equal(owner.snapshot.restart_required,true);}finally{await owner.close();}
});
