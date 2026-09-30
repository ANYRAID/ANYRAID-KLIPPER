import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
test('compiled client fixture prints, pauses, resumes, reinitializes and survives cancelled preparation', {timeout:150000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'client-probe-check-')),reserve=createServer();await writeFile(join(root,'index.html'),'<!doctype html><title>Fixture</title>');
 await new Promise<void>(resolve=>reserve.listen(0,'127.0.0.1',resolve));const address=reserve.address();assert(address&&typeof address!=='string');const port=address.port;await new Promise<void>((resolve,reject)=>reserve.close(error=>error?reject(error):resolve()));
 const child=spawn(process.execPath,[fileURLToPath(new URL('./client-probe.ts',import.meta.url)),root,String(port)],{stdio:['ignore','pipe','pipe']}),ready=Promise.withResolvers<void>();let stderr='',output='';child.stdout.on('data',chunk=>{output=(output+String(chunk)).slice(-65536);if(output.includes('CLIENT_READY'))ready.resolve();});child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-65536);});child.on('error',error=>ready.reject(error));
 const ended=new Promise<number|null>(resolve=>child.once('exit',code=>{ready.reject(new Error('Fixture ended before ready: '+stderr));resolve(code);}));
 try{
  await Promise.race([ready.promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Fixture startup timeout: '+stderr)),90000);timer.unref();ready.promise.finally(()=>clearTimeout(timer)).catch(()=>{});})]);const base=`http://127.0.0.1:${port}`;
  const login=await fetch(base+'/access/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'operator',password:'client-test-only'})});assert.equal(login.status,200);const token=(await login.json()).result.token,headers={authorization:'Bearer '+token,'content-type':'application/json'};
  const invoke=async(path:string,body?:object)=>{const response=await fetch(base+path,{headers,...body?{method:'POST',body:JSON.stringify(body)}:{},signal:AbortSignal.timeout(5000)});assert.equal(response.status,200,path);return (await response.json()).result;};
  assert((await invoke('/server/files/list')).some((file:any)=>file.path==='client-sample.gcode'));
  const waitState=async(wanted:string)=>{const deadline=performance.now()+20000;for(;;){const state=await invoke('/printer/print/status');if(state.state===wanted)return state;assert.notEqual(state.state,'failed',JSON.stringify(state));assert(performance.now()<deadline,JSON.stringify(state));await delay(50);}};
  assert.equal(await invoke('/printer/print/start',{filename:'client-sample.gcode'}),'ok');await waitState('printing');
  assert.equal((await invoke('/printer/objects/query?toolhead')).status.toolhead.homed_axes,'xyz');
  assert.equal(await invoke('/printer/print/pause',{}),'ok');await waitState('paused');await delay(200);assert.equal((await invoke('/printer/print/status')).state,'paused');
  assert.equal(await invoke('/printer/print/resume',{}),'ok');await waitState('completed');
  const hostState=await invoke('/printer/host/status');assert.equal((await invoke('/printer/host/reinitialize',{version:1,request_id:'client-reinitialize',state_token:hostState.state_token})).accepted,true);
  const until=performance.now()+10000;while(!output.includes('CLIENT_GENERATION 2')){assert(performance.now()<until,stderr);await delay(50);}
  assert.equal((await invoke('/printer/print/status')).state,'idle');assert.equal((await invoke('/server/history/list')).jobs[0].status,'completed');
  assert.equal(await invoke('/printer/print/start',{filename:'client-sample.gcode'}),'ok');await delay(150);assert.equal(await invoke('/printer/print/cancel',{}),'ok');
  for(let i=0;i<15;i++){await delay(1000);assert.equal((await invoke('/printer/print/status')).state,'cancelled');assert.equal(child.exitCode,null);}
  const state=await invoke('/printer/print/status');assert.equal(state.pending_device_actions,0);assert.equal(state.safe_stop_pending,false);assert.equal((await invoke('/machine/system_info')).system_info.runtime.name,'node');assert(Array.isArray((await invoke('/machine/proc_stats')).moonraker_stats));
  t.diagnostic(output.match(/CLIENT_ARTIFACT [a-f0-9]+/)?.[0]??'missing artifact');assert(output.includes('CLIENT_GENERATION 2'));child.kill('SIGINT');assert.equal(await ended,0,stderr);assert(!stderr.includes('EAGAIN'));assert(!output.includes('CLIENT_TIMEOUT'));
 }finally{if(child.exitCode===null)child.kill('SIGINT');await Promise.race([ended,delay(5000).then(()=>{if(child.exitCode===null)child.kill('SIGKILL');})]);await rm(root,{recursive:true,force:true});}
});
