import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
for(const trustedLoopback of [false,true])test(`compiled client fixture preserves service and MCU identity across reinitialize, restart and firmware restart (trusted=${trustedLoopback})`, {timeout:180000},async t=>{
 const sockets:WebSocket[]=[];
 const root=await mkdtemp(join(tmpdir(),'client-probe-check-')),reserve=createServer();await writeFile(join(root,'index.html'),'<!doctype html><title>Fixture</title>');
 await new Promise<void>(resolve=>reserve.listen(0,'127.0.0.1',resolve));const address=reserve.address();assert(address&&typeof address!=='string');const port=address.port;await new Promise<void>((resolve,reject)=>reserve.close(error=>error?reject(error):resolve()));
 const child=spawn(process.execPath,[fileURLToPath(new URL('./client-probe.ts',import.meta.url)),root,String(port),...trustedLoopback?['--trusted-loopback']:[]],{stdio:['ignore','pipe','pipe']}),ready=Promise.withResolvers<void>();let stderr='',output='';child.stdout.on('data',chunk=>{output=(output+String(chunk)).slice(-65536);if(output.includes('CLIENT_READY'))ready.resolve();});child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-65536);});child.on('error',error=>ready.reject(error));
 const ended=new Promise<number|null>(resolve=>child.once('exit',code=>{ready.reject(new Error('Fixture ended before ready: '+stderr));resolve(code);}));
 try{
  await Promise.race([ready.promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Fixture startup timeout: '+stderr)),90000);timer.unref();ready.promise.finally(()=>clearTimeout(timer)).catch(()=>{});})]);const base=`http://127.0.0.1:${port}`;
  assert.equal((await fetch(base+'/server/info')).status,trustedLoopback?200:401);
  const login=await fetch(base+'/access/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'operator',password:'client-test-only'})});assert.equal(login.status,200);const token=(await login.json()).result.token,headers={'content-type':'application/json',...trustedLoopback?{}:{authorization:'Bearer '+token}};
  const invoke=async(path:string,body?:object)=>{const response=await fetch(base+path,{headers,...body?{method:'POST',body:JSON.stringify(body)}:{},signal:AbortSignal.timeout(5000)});assert.equal(response.status,200,path);return (await response.json()).result;};
  const connect=async()=>{
   const ws=new WebSocket(base.replace('http:','ws:')+'/websocket');sockets.push(ws);const notifications:any[]=[];let id=0;const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
   ws.on('message',data=>{const value=JSON.parse(String(data));if(value.method){notifications.push(value);return;}const task=pending.get(value.id);if(!task)return;clearTimeout(task.timer);pending.delete(value.id);if(value.error)task.reject(Error(JSON.stringify(value.error)));else task.resolve(value.result);});
   ws.on('close',()=>{for(const task of pending.values()){clearTimeout(task.timer);task.reject(Error('Connection closed'));}pending.clear();});
   await once(ws,'open',{signal:AbortSignal.timeout(5000)});
   const call=(method:string,params:object)=>new Promise<any>((resolve,reject)=>{const request=++id,timer=setTimeout(()=>{pending.delete(request);reject(Error('RPC timeout: '+method));},5000);pending.set(request,{resolve,reject,timer});ws.send(JSON.stringify({jsonrpc:'2.0',id:request,method,params}));});
   await call('server.connection.identify',{client_name:'reconnect-check',version:'1',type:'web',url:'http://printer.test',...trustedLoopback?{}:{access_token:token}});
   const snapshot=await call('printer.objects.subscribe',{objects:{print_stats:['state','filename'],pause_resume:['is_paused'],motion_report:['live_velocity']}});
   return {ws,call,snapshot,notifications};
  };
  const waitNotification=async(peer:Awaited<ReturnType<typeof connect>>,state:string)=>{const until=performance.now()+5000;while(!peer.notifications.some(n=>n.method==='notify_status_update'&&n.params[0]?.print_stats?.state===state)){assert(performance.now()<until,'Missing subscribed state '+state);await delay(20);}};
  let peer=await connect();
  assert((await invoke('/server/info')).components.includes('history'),'actual registered native history must be discoverable by UI');
  assert((await invoke('/server/files/list')).some((file:any)=>file.path==='client-sample.gcode'));
  const waitState=async(wanted:string)=>{const deadline=performance.now()+20000;for(;;){const state=await invoke('/printer/print/status');if(state.state===wanted)return state;assert.notEqual(state.state,'failed',JSON.stringify(state));assert(performance.now()<deadline,JSON.stringify(state));await delay(50);}};
  assert.equal(await invoke('/printer/print/start',{filename:'client-sample.gcode'}),'ok');await waitState('printing');await waitNotification(peer,'printing');
  const active=await invoke('/printer/print/status'),disconnected=once(peer.ws,'close',{signal:AbortSignal.timeout(5000)});child.kill('SIGUSR2');await disconnected;
  peer=await connect();assert.equal(peer.snapshot.status.print_stats.state,'printing');assert.equal(peer.snapshot.status.print_stats.filename,'client-sample.gcode');assert.equal((await invoke('/printer/print/status')).request.request_id,active.request.request_id,'reconnect must not restart the job');
  assert.equal((await invoke('/printer/objects/query?toolhead')).status.toolhead.homed_axes,'xyz');
  assert.equal(await invoke('/printer/print/pause',{}),'ok');await waitState('paused');await waitNotification(peer,'paused');await delay(200);assert.equal((await invoke('/printer/print/status')).state,'paused');
  assert.equal(await invoke('/printer/print/resume',{}),'ok');await waitState('completed');await waitNotification(peer,'complete');
  const hostState=await invoke('/printer/host/status');assert.equal((await invoke('/printer/host/reinitialize',{version:1,request_id:'client-reinitialize',state_token:hostState.state_token})).accepted,true);
  const until=performance.now()+10000;while(!output.includes('CLIENT_GENERATION 2')){assert(performance.now()<until,stderr);await delay(50);}
  assert.equal(peer.ws.readyState,WebSocket.OPEN);const renewed=await peer.call('printer.objects.subscribe',{objects:{print_stats:['state','filename'],pause_resume:['is_paused']}});assert.equal(renewed.status.print_stats.state,'standby');assert.equal(renewed.status.pause_resume.is_paused,false);
  for(const [route,expected] of [['restart',3],['firmware_restart',4]] as const){
   assert.equal(await invoke('/printer/'+route,{}),'ok');const deadline=performance.now()+15000;while(!output.includes('CLIENT_GENERATION '+expected)){assert(performance.now()<deadline,stderr);await delay(50);}
   assert.equal(peer.ws.readyState,WebSocket.OPEN);const snapshot=await peer.call('printer.objects.subscribe',{objects:{print_stats:['state']}});assert.equal(snapshot.status.print_stats.state,'standby');assert((await invoke('/server/files/list')).some((file:any)=>file.path==='client-sample.gcode'));
   assert((await invoke('/server/info')).components.includes('history'));
   if(route==='restart'){assert.equal(await invoke('/printer/print/start',{filename:'client-sample.gcode'}),'ok');await waitState('printing');await waitState('completed');}
  }
  const traffic=output.split('\n').filter(line=>line.startsWith('CLIENT_FIRMWARE ')).map(line=>JSON.parse(line.slice('CLIENT_FIRMWARE '.length)));assert.equal(traffic.length,4);assert.deepEqual(traffic.map(devices=>devices.map((d:any)=>d.resets)),[[0,0],[0,0],[0,0],[1,1]]);assert.deepEqual(traffic.map(devices=>devices.map((d:any)=>d.configurations)),[[1,1],[1,1],[1,1],[2,2]]);
  t.diagnostic(JSON.stringify({clientRecovery:{trustedLoopback,printingReconnect:true,jobIdentityPreserved:true,freshSubscription:true,sameConnectionPreserved:true,newGenerationAuthenticated:true,originalFirmwareReset:true}}));
  assert.equal((await invoke('/printer/print/status')).state,'idle');assert.equal((await invoke('/server/history/list')).jobs[0].status,'completed');
  assert.equal(await invoke('/printer/print/start',{filename:'client-sample.gcode'}),'ok');await delay(150);assert.equal(await invoke('/printer/print/cancel',{}),'ok');
  for(let i=0;i<15;i++){await delay(1000);assert.equal((await invoke('/printer/print/status')).state,'cancelled');assert.equal(child.exitCode,null);}
  const state=await invoke('/printer/print/status');assert.equal(state.pending_device_actions,0);assert.equal(state.safe_stop_pending,false);assert.equal((await invoke('/machine/system_info')).system_info.runtime.name,'node');assert(Array.isArray((await invoke('/machine/proc_stats')).moonraker_stats));
  const history=await invoke('/server/history/list'),files=await invoke('/server/files/list'),before=(await invoke('/printer/info')).process_id;
  const processClosed=once(peer.ws,'close',{signal:AbortSignal.timeout(10000)});child.kill('SIGUSR1');await processClosed;
  const recoveryDeadline=performance.now()+20000;while(!output.includes('CLIENT_PROCESS_READY 2')){assert(performance.now()<recoveryDeadline,stderr);assert.equal(child.exitCode,null,stderr);await delay(50);}
  assert.notEqual((await invoke('/printer/info')).process_id,before);assert.deepEqual((await invoke('/server/history/list')).jobs,history.jobs);assert.deepEqual(await invoke('/server/files/list'),files);
  assert((await invoke('/server/info')).components.includes('history'));
  peer=await connect();assert.equal(peer.snapshot.status.print_stats.state,'standby');assert.equal((await invoke('/printer/print/status')).state,'idle');
  const lastTraffic=JSON.parse(output.split('\n').filter(line=>line.startsWith('CLIENT_FIRMWARE ')).at(-1)!.slice('CLIENT_FIRMWARE '.length));assert.deepEqual(lastTraffic.map((d:any)=>[d.resets,d.configurations]),[[1,2],[1,2]]);
  const artifacts=[...output.matchAll(/CLIENT_ARTIFACT ([a-f0-9]+)/g)].map(match=>match[1]);assert.equal(artifacts.length,2);assert.equal(artifacts[0],artifacts[1]);
  t.diagnostic(JSON.stringify({processRecovery:{trustedLoopback,newProcess:true,sameArtifact:true,sameMcuConfiguration:true,originalJwt:true,filesAndHistoryPreserved:true,noPrintReplay:true}}));
  t.diagnostic(output.match(/CLIENT_ARTIFACT [a-f0-9]+/)?.[0]??'missing artifact');assert(output.includes('CLIENT_GENERATION 2'));child.kill('SIGINT');assert.equal(await ended,0,stderr);assert(!stderr.includes('EAGAIN'));assert(!output.includes('CLIENT_TIMEOUT'));
 }finally{for(const socket of sockets)socket.terminate();if(child.exitCode===null)child.kill('SIGINT');await Promise.race([ended,delay(5000).then(()=>{if(child.exitCode===null)child.kill('SIGKILL');})]);await rm(root,{recursive:true,force:true});}
});
