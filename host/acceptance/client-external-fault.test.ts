import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {createClientFaultSession} from './client-fault-runner.ts';

// This is an API/tooling fixture check, not Fluidd/Mainsail browser acceptance.
for(const recovery of ['clear-file','firmware-first'] as const)test(`locked product gateway exposes external crash and explicit ${recovery} recovery`, {timeout:150000},async t=>{
 const assets=process.env.ANYRAID_CLIENT_FIXED_ASSETS;if(!assets)throw new Error('Explicit fixed frontend assets required');
 const records:unknown[]=[],session=await createClientFaultSession(assets,18428,18430,value=>{records.push(value);t.diagnostic(JSON.stringify(value));});let passed=false;
 const origin=session.origin;
 async function request(path:string,method='GET',body?:unknown,cookie?:string){const response=await fetch(origin+path,{method,headers:{origin,...cookie?{cookie}:{},...body instanceof FormData?{}:{'content-type':'application/json'}},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const raw=await response.text();let value:any;try{value=JSON.parse(raw);}catch{value=raw;}return {code:response.status,body:value,cookie:response.headers.get('set-cookie')?.split(';')[0]};}
 let cookie='';
 async function get(path:string){const r=await request(path,'GET',undefined,cookie);assert.equal(r.code,200,JSON.stringify(r));return r.body.result;}
 async function post(path:string,body?:unknown){const r=await request(path,'POST',body,cookie);assert.equal(r.code,200,JSON.stringify(r));return r.body.result;}
 async function until(check:()=>Promise<boolean>,label:string,ms=20000){const deadline=performance.now()+ms;while(!await check()){assert(performance.now()<deadline,label);await delay(20);}}
 async function upload(name:string,code:string){const form=new FormData();form.append('file',new Blob([code]),name);form.append('root','gcodes');const r=await request('/server/files/upload','POST',form,cookie);assert.equal(r.code,201,JSON.stringify(r));assert.equal(r.body.result.print_started,false);}
 try{
  const login=await request('/_client/session','POST',{username:'operator',password:'client-test-only'});assert.equal(login.code,200);assert(login.cookie);cookie=login.cookie;
  await upload('external-active.gcode','G90\nG92 E0\n'+Array.from({length:1000},(_,i)=>`G1 X${(i+1)/100} E${(i+1)/1000} F6\n`).join('')+'M400\n');
  await upload('external-next.gcode','G90\nG1 X0.1 F600\nM400\n');
  await post('/printer/gcode/script',{script:'G28'});await until(async()=>(await get('/server/info')).native_host.homed_axes.includes('x'),'initial actual homing');
  await post('/printer/print/start',{filename:'external-active.gcode'});await until(async()=>(await get('/printer/print/status')).state==='printing','active simulated job',30000);
  const before=await get('/server/history/list');assert.equal(before.count,1);const requestId=before.jobs[0].metadata.native_request_id;assert(requestId);t.diagnostic(JSON.stringify({event:'active-request',requestId,state:before.jobs[0].status}));
  await assert.rejects(session.crash(),/arm/);
  session.arm();assert.throws(()=>session.arm(),/arm/);const oldPid=session.productPid,receipt=await session.crash();assert.equal(receipt.pid,oldPid);assert.equal(receipt.signal,'SIGKILL');assert.equal(receipt.requestsJoined,true);assert.equal(receipt.simulationClosed,true);await assert.rejects(session.crash(),/arm/);
  const motionAfterCrash=session.firmware.map(mcu=>mcu.motion.length);
  assert.equal(session.state,'offline');assert.equal(session.generation,1);const offline=await request('/server/info','GET',undefined,cookie);assert.equal(offline.code,502,JSON.stringify(offline));
  const db=new DatabaseSync(session.config.journalPath,{readOnly:true});try{const rows=db.prepare('SELECT id,state FROM requests').all();assert.equal(rows.length,1);assert.equal(rows[0].id,requestId);assert.equal(rows[0].state,'started');}finally{db.close();}
  assert.equal(session.generation,1,'offline observation must not restart the child');await session.recover();assert.notEqual(session.productPid,oldPid);assert.equal(session.generation,2);assert.throws(()=>session.arm(),/arm/);
  const resumed=await get('/printer/print/status');assert.equal(resumed.state,'interrupted');const history=await get('/server/history/list');assert.equal(history.count,1);assert.equal(history.jobs[0].metadata.native_request_id,requestId);assert.equal(history.jobs[0].status,'interrupted');assert.equal((await get('/server/info')).native_host.homed_axes,'');
  assert.deepEqual(session.firmware.map(mcu=>mcu.motion.length),motionAfterCrash,'new process must not submit motion from the interrupted job');
  await delay(200);assert.deepEqual(session.firmware.map(mcu=>mcu.motion.length),motionAfterCrash);assert.equal((await get('/printer/print/status')).state,'interrupted');assert.equal((await get('/server/history/list')).count,1);
  t.diagnostic(JSON.stringify({event:'interrupted-no-replay',requestId,state:resumed.state,motionAfterCrash,motionAfterRecovery:session.firmware.map(mcu=>mcu.motion.length)}));
  if(recovery==='clear-file'){
  await post('/printer/gcode/script',{script:'sdcard_reset_file'});const cleared=await get('/printer/print/status');assert.equal(cleared.state,'idle');assert.equal(cleared.request,null);
  const durable=await get('/printer/print/status?request_id='+requestId);assert.equal(durable.record.state,'cancelled');assert.equal(durable.record.request.request_id,requestId);
  assert.equal((await get('/server/history/list')).jobs.find((job:any)=>job.metadata.native_request_id===requestId).status,'cancelled');
  t.diagnostic(JSON.stringify({event:'explicit-clear-file',state:cleared.state,durable:durable.record,nativeHost:(await get('/server/info')).native_host}));
  }
  const motionBeforeFirmware=session.firmware.map(mcu=>mcu.motion.length);
  await post('/printer/firmware_restart');await until(async()=>{const status=await get('/printer/host/status');return status.firmware_restart_operation?.state==='succeeded'&&status.busy===false;},'explicit firmware recovery receipt',20000);assert.equal((await get('/server/info')).native_host.ready,true);t.diagnostic(JSON.stringify({event:'explicit-firmware-recovery',receipt:await get('/printer/host/status'),nativeHost:(await get('/server/info')).native_host}));
  assert.deepEqual(session.firmware.map(mcu=>mcu.motion.length),motionBeforeFirmware,'explicit firmware recovery must not replay old task motion');assert.equal((await get('/server/info')).native_host.homed_axes,'');
  const firmwareState=await get('/printer/print/status');assert.equal(firmwareState.state,'idle');assert.equal(firmwareState.request,null);const firmwareHistory=await get('/server/history/list');assert.equal(firmwareHistory.count,1);assert.equal(firmwareHistory.jobs[0].metadata.native_request_id,requestId);assert.equal(firmwareHistory.jobs[0].status,'cancelled');assert.equal((await get('/printer/print/status?request_id='+requestId)).record.state,'cancelled');
  t.diagnostic(JSON.stringify({event:'firmware-first-proof',recovery,requestId,motionBeforeFirmware,motionAfterFirmware:session.firmware.map(mcu=>mcu.motion.length),history:firmwareHistory}));
  await post('/printer/gcode/script',{script:'G28'});await until(async()=>(await get('/server/info')).native_host.homed_axes.includes('x'),'explicit recovery homing');
  await post('/printer/print/start',{filename:'external-next.gcode'});await until(async()=>(await get('/server/history/list')).jobs.some((job:any)=>job.filename==='external-next.gcode'&&job.status==='completed'),'explicit different job completes',30000);
  const final=await get('/server/history/list');assert.equal(final.count,2);assert.notEqual(final.jobs[0].metadata.native_request_id,requestId);assert.equal(final.jobs.find((job:any)=>job.metadata.native_request_id===requestId).status,'cancelled');
  if(recovery==='clear-file'){await post('/printer/gcode/script',{script:'SDCARD_RESET_FILE'});assert.equal((await get('/printer/print/status')).state,'idle');assert.equal((await get('/server/history/list')).count,2);}
  assert.equal(records.filter((row:any)=>row.event==='gateway-spawn').length,1);passed=true;
 }finally{await session.close();t.diagnostic(JSON.stringify({event:'fixture-files',root:session.root,passed}));if(passed)await session.dispose();}
});
