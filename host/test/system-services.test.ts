import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {SystemServices,linuxServiceSource,processServiceUnit,validateSystemServices,type ServiceSnapshot,type ServiceCommand} from '../src/moonraker/system-services.ts';
const signal=()=>new AbortController().signal;
const value=(active='active'):ServiceSnapshot=>({provider:'systemd_cli',available_services:['klipper'],service_state:{klipper:{active_state:active,sub_state:active==='active'?'running':'dead'}},instance_ids:{moonraker:'',klipper:''}});
const properties=(unit:string,active='active',load='loaded')=>`Id=${unit}\nLoadState=${load}\nActiveState=${active}\nSubState=${active==='active'?'running':'dead'}\n`;
test('process service identity is a bounded unambiguous kernel cgroup unit, including a shared native service',()=>{
 assert.equal(processServiceUnit('0::/system.slice/anyraid-node-product-host.service\n'),'anyraid-node-product-host.service');
 assert.equal(processServiceUnit('1:name=systemd:/system.slice/klipper-2.service\n2:cpu:/system.slice/klipper-2.service'),'klipper-2.service');
 assert.equal(processServiceUnit('0::/user.slice/user-1000.slice/session-1.scope'),null);
 assert.equal(processServiceUnit('0::/system.slice/a.service\n1:cpu:/system.slice/b.service'),null);
 assert.equal(processServiceUnit('0::/system.slice/--bad.service'),null);assert.equal(processServiceUnit('x'.repeat(65537)),null);
});
test('systemd uses fixed read-only argv, an exact allowlist and ordered named properties for the actual shared unit',async()=>{
 const calls:readonly string[][]=[];const mutable=calls as string[][];
 const command:ServiceCommand=async args=>{mutable.push([...args]);if(args.includes('list-units'))return 'klipper.service loaded active running Description\nmoonraker-2.service loaded inactive dead Description\nmoonraker-evil.service loaded active running Secret\nssh.service loaded active running Secret\ncustom.service loaded active running Custom\nescaped\\x20unit.service loaded active exited Escaped\nklipper\\x2devil.service loaded active running Escaped\n';return args.slice(4).map(unit=>properties(unit)).join('\n');};
 const source=linuxServiceSource({command,allowedUnits:['custom.service'],nativeCombined:true,readCgroup:async()=> '0::/system.slice/anyraid-prod.service'});
 const snapshot=await source(signal());assert.equal(snapshot.provider,'systemd_cli');assert.deepEqual(snapshot.available_services,['anyraid-prod','custom','klipper','moonraker-2']);assert.deepEqual(snapshot.instance_ids,{moonraker:'anyraid-prod',klipper:'anyraid-prod'});
 assert.deepEqual(mutable[0],['--no-pager','--no-ask-password','list-units','--all','--type=service','--plain','--no-legend','--full']);
 assert.deepEqual(mutable[1],['--no-pager','--no-ask-password','show','--property=Id,LoadState,ActiveState,SubState','anyraid-prod.service','custom.service','klipper.service','moonraker-2.service']);
 assert(!JSON.stringify(snapshot).includes('Secret'));assert(!JSON.stringify(snapshot).includes('Environment'));
});
test('successful empty detection is systemd evidence, missing own unit is omitted, aliases and partial snapshots fail',async()=>{
 let output='';const command:ServiceCommand=async args=>args.includes('list-units')?'':output;
 assert.deepEqual(await linuxServiceSource({command,readCgroup:async()=>''})(signal()),{provider:'systemd_cli',available_services:[],service_state:{},instance_ids:{moonraker:'',klipper:''}});
 const own=linuxServiceSource({command,nativeCombined:true,readCgroup:async()=> '0::/system.slice/own.service'});output=properties('own.service','inactive','not-found');assert.deepEqual((await own(signal())).instance_ids,{moonraker:'',klipper:''});
 for(const invalid of [properties('other.service'),'Id=own.service\nActiveState=active\nSubState=running','Id=own.service\nLoadState=loaded\nActiveState=active\nSubState=running\nSubState=dead',properties('own.service')+'Environment=secret\n']){output=invalid;await assert.rejects(own(signal()),/properties/);}
});
test('malformed, oversized or excessive command results reject complete snapshots and unit options reject injection',async()=>{
 for(const listing of ['● klipper.service loaded failed failed Test','klipper.service loaded active','klipper.service loaded Active running Test','x'.repeat(1048577)])await assert.rejects(linuxServiceSource({command:async()=>listing,readCgroup:async()=>''})(signal()),/service list/);
 const listing=Array.from({length:65},(_,i)=>`klipper-${i}.service loaded active running Test`).join('\n');await assert.rejects(linuxServiceSource({command:async()=>listing,readCgroup:async()=>''})(signal()),/capacity/);
 for(const allowedUnits of [['--system.service'],['a.service;reboot'],['../a.service'],['a.service','a.service'],Array(65).fill('a.service')])assert.throws(()=>validateSystemServices({allowedUnits}),/allowed service units/);
 assert.throws(()=>validateSystemServices({source:async()=>value(),allowedUnits:[]}),/owns its allowlist/);assert.throws(()=>validateSystemServices({control:()=>{}} as any),/options/);
});
test('sampler initializes silently, isolates snapshots, emits per-service deltas after commit and retains good state on source failure',async()=>{
 const events:any[]=[];let next:any=value(),fail=false;const info=new SystemServices({source:async()=>{if(fail)throw new Error('private failure');return next;}},change=>{events.push(change);assert.equal((info.snapshot().service_state as any).klipper.active_state,'inactive');});
 try{await info.refresh();assert.equal(events.length,0);const copy:any=info.snapshot();copy.service_state.klipper.active_state='fake';assert.equal((info.snapshot().service_state as any).klipper.active_state,'active');
  next=value('inactive');await info.refresh();assert.deepEqual(events,[{klipper:{active_state:'inactive',sub_state:'dead'}}]);next.service_state.klipper.active_state='active';assert.equal((info.snapshot().service_state as any).klipper.active_state,'inactive');
  next=value('inactive');await info.refresh();assert.equal(events.length,1);fail=true;await assert.rejects(info.refresh(),/private failure/);assert.equal(info.status.samples,3);assert.equal((info.snapshot().service_state as any).klipper.active_state,'inactive');
  fail=false;next={...value(),available_services:['klipper','fake']};await assert.rejects(info.refresh(),/catalogue/);assert.equal(info.status.samples,3);assert.equal(events.length,1);
 }finally{await info.close();}
});
test('initial unavailable provider stays truthful and recovers on a later poll; observer failures do not undo state',async()=>{
 let fail=true;const info=new SystemServices({source:async()=>{if(fail)throw new Error('private unavailable');return value();}},()=>{throw new Error('observer');});
 try{await info.start();assert.equal(info.snapshot().provider,'none');assert.equal(info.status.failures,1);assert.equal(info.status.samples,0);fail=false;await info.refresh();assert.equal(info.snapshot().provider,'systemd_cli');assert.equal(info.status.notification_failures,0);fail=true;
  const second=new SystemServices({source:async()=>value(fail?'inactive':'active')},()=>{throw new Error('observer');});try{await second.refresh();fail=false;await second.refresh();assert.equal(second.status.notification_failures,1);assert.equal((second.snapshot().service_state as any).klipper.active_state,'active');}finally{await second.close();}
 }finally{await info.close();}
});
test('concurrent polls coalesce; close aborts and joins the child source, rejecting late publication',async()=>{
 const pending=Promise.withResolvers<ServiceSnapshot>();let activeSignal:AbortSignal|undefined,calls=0;
 const info=new SystemServices({source:async s=>{activeSignal=s;calls++;return pending.promise;}});const first=info.refresh(),second=info.refresh();assert.equal(first,second);await Promise.resolve();assert.equal(calls,1);
 const rejected=assert.rejects(first,/closed/);let closed=false;const close=info.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(activeSignal?.aborted,true);assert.equal(closed,false);pending.resolve(value());await rejected;await close;assert.equal(info.status.samples,0);assert.equal(info.status.pending,false);await assert.rejects(info.refresh(),/closed/);
});
test('real query children are reaped before cancellation, deadline or output-capacity rejection completes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'service-query-child-')),script=join(dir,'systemctl'),keys=['PATH','ANYRAID_SERVICE_TEST_PID','ANYRAID_SERVICE_TEST_MODE'],previous=new Map(keys.map(key=>[key,process.env[key]]));
 try{
  await writeFile(script,'#!'+process.execPath+'\nconst fs=require("node:fs");process.on("SIGTERM",()=>{});fs.writeFileSync(process.env.ANYRAID_SERVICE_TEST_PID,String(process.pid));if(process.env.ANYRAID_SERVICE_TEST_MODE==="overflow")process.stdout.write("x".repeat(1100000));setInterval(()=>{},10000);\n');await chmod(script,0o700);process.env.PATH=dir;
  for(const mode of ['cancel','timeout','overflow']){
   process.env.ANYRAID_SERVICE_TEST_MODE=mode;const pidPath=join(dir,mode+'.pid');process.env.ANYRAID_SERVICE_TEST_PID=pidPath;
   const services=new SystemServices({source:linuxServiceSource({readCgroup:async()=>''})});const operation=services.refresh(),rejected=assert.rejects(operation,mode==='cancel'?/closed/:/Service query unavailable/);
   try{
    let pid=0;const deadline=Date.now()+3000;while(!pid&&Date.now()<deadline){try{pid=Number(await readFile(pidPath,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(!pid)await delay(10);}
    assert(Number.isSafeInteger(pid)&&pid>0,'Query child must actually start');let watchdogFired=false;
    const watchdog=setTimeout(()=>{watchdogFired=true;try{process.kill(pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}},3000);
    try{if(mode==='cancel')await services.close();await rejected;}finally{clearTimeout(watchdog);}assert.equal(watchdogFired,false,'Query owner must terminate its child before the test cleanup watchdog');
    assert.throws(()=>process.kill(pid,0),(error:unknown)=>(error as NodeJS.ErrnoException).code==='ESRCH','Query completion must join actual child exit');assert.equal(services.status.samples,0);assert.equal(services.status.pending,false);
   }finally{await services.close();}
  }
 }finally{for(const key of keys){const value=previous.get(key);if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(dir,{recursive:true,force:true});}
});
