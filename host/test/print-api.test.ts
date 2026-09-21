import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {setImmediate as immediate} from 'node:timers/promises';
import {PrintApi,registerPrintApi,type PrintBackend} from '../src/moonraker/print-api.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {ApiError,JsonRpcDispatcher,type Json,type RpcContext} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {printApiOracle} from './helpers/print-api-oracle.ts';
const context=():RpcContext=>({transport:'http',signal:new AbortController().signal,authorize:()=>({username:'alice'})});
function fixture(){const calls:Json[]=[],abort=new AbortController(),gate=new MaintenanceGate(),backend:PrintBackend={signal:abort.signal,snapshot:{connected:true,initialized:true,state:'ready',endpoints:['gcode/script','pause_resume/pause','pause_resume/resume','pause_resume/cancel']},async request(method,params){calls.push([method,params]);return 'ok';}};return {backend,calls,gate,abort};}
test('four print controls match pinned upstream command selection and normal filename encoding',async()=>{
 const f=fixture(),api=new PrintApi({backend:()=>f.backend,maintenanceGate:f.gate}),cases=[{action:'start',filename:'/parts/打印 "one";#.gcode'},{action:'pause'},{action:'resume'},{action:'cancel'}] as const;
 for(const item of cases)assert.equal(await api.call(item.action,'filename' in item?{filename:item.filename}:{},context()),'ok');
 const reference=JSON.parse(execFileSync('/usr/bin/python3',['-c',printApiOracle()],{input:JSON.stringify({cases}),encoding:'utf8'}));assert.deepEqual(f.calls,reference);assert.equal(f.gate.status.activities,0);
});
test('filenames cannot inject commands, while literal quotes and backslashes survive POSIX shlex',async()=>{
 const f=fixture(),api=new PrintApi({backend:()=>f.backend,maintenanceGate:f.gate});
 for(const filename of ['',null,'../a','//a','a//b','a/./b','a/../b','a\nM112','a\rM112','a\0b','\ud800','a'.repeat(4097)])await assert.rejects(api.call('start',{filename},context()),e=>e instanceof ApiError&&e.status===400);
 assert.equal(f.calls.length,0);const filename='parts/back\\slash "#;".gcode';await api.call('start',{filename},context());
 const script=(f.calls[0] as any)[1].script,decoded=JSON.parse(execFileSync('/usr/bin/python3',['-c',"import json,sys,shlex;s=shlex.shlex(json.load(sys.stdin),posix=True);s.whitespace_split=True;s.commenters='#;';print(json.dumps(list(s)))"],{input:JSON.stringify(script),encoding:'utf8'}));
 assert.deepEqual(decoded,['SDCARD_PRINT_FILE','FILENAME='+filename]);
});
test('authorization identity reaches only successful start observers and never comes from params',async()=>{
 const f=fixture(),events:any[]=[],api=new PrintApi({backend:()=>f.backend,maintenanceGate:f.gate,onStartComplete:event=>{events.push(event);}}),routes=new EndpointRegistry(new JsonRpcDispatcher()),release=registerPrintApi(routes,api);
 assert.equal(await routes.invoke('/printer/print/start','POST',{filename:'a',username:'forged'},context()),'ok');assert.equal(events[0].user.username,'alice');assert.ok(Object.isFrozen(events[0]));
 f.backend.request=async()=>{throw new ApiError(400,'File missing');};await assert.rejects(routes.invoke('/printer/print/start','POST',{filename:'b'},context()),/File missing/);assert.equal(events.length,1);
 await assert.rejects(routes.invoke('/printer/print/start','GET',{filename:'a'},context()),e=>e instanceof ApiError&&e.status===405);
 release();await assert.rejects(routes.invoke('/printer/print/start','POST',{filename:'a'},context()),e=>e instanceof ApiError&&e.status===404);
});
test('pending starts are not replayed, cancellation still reaches backend, and maintenance waits for settlement',async()=>{
 const f=fixture(),wait=Promise.withResolvers<Json>(),api=new PrintApi({backend:()=>f.backend,maintenanceGate:f.gate});let started=0;
 f.backend.request=async(method)=>{if(method==='gcode/script'){started++;return wait.promise;}return 'ok';};
 const pending=api.call('start',{filename:'a'},context());assert.equal(api.status.starting,true);
 await assert.rejects(api.call('start',{filename:'a'},context()),e=>e instanceof ApiError&&e.status===409);assert.equal(await api.call('cancel',{},context()),'ok');assert.throws(()=>f.gate.acquire());
 api.close();const rejected=assert.rejects(pending,/closed/);assert.equal(f.gate.status.activities,1);wait.resolve('ok');await rejected;assert.equal(started,1);f.gate.acquire()();assert.equal(api.status.starting,false);
});
test('readiness, generation disconnect and maintenance rejection do not send commands or success events',async()=>{
 const f=fixture();let events=0;const api=new PrintApi({backend:()=>f.backend,maintenanceGate:f.gate,onStartComplete:()=>{events++;}});
 const release=f.gate.acquire();await assert.rejects(api.call('resume',{},context()),e=>e instanceof ApiError&&e.status===409);release();
 f.backend.snapshot.state='shutdown';await assert.rejects(api.call('start',{filename:'a'},context()),e=>e instanceof ApiError&&e.status===503);f.backend.snapshot.state='ready';
 f.backend.request=async()=>{f.abort.abort();return 'ok';};await assert.rejects(api.call('start',{filename:'a'},context()));assert.equal(events,0);assert.equal(f.calls.length,0);assert.equal(f.gate.status.activities,0);
});
test('a slow or failed observational callback cannot trigger retry or grow an unbounded queue',async()=>{
 const f=fixture(),wait=Promise.withResolvers<void>();let calls=0;const api=new PrintApi({backend:()=>f.backend,maintenanceGate:f.gate,onStartComplete:()=>{calls++;return wait.promise;}});
 await api.call('start',{filename:'a'},context());await api.call('start',{filename:'b'},context());assert.equal(calls,1);assert.equal(api.status.observerPending,true);assert.match(api.status.observerError!,/capacity/);
 wait.reject(new Error('Observer fault'));await immediate();assert.equal(api.status.observerPending,false);assert.equal(api.status.observerError,'Observer fault');assert.equal(f.calls.length,2);
});
