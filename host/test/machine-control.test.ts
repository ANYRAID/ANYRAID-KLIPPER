import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {LinuxMachineControl,MachineControlError,type MachineAction,type MachineControlIO} from '../src/moonraker/machine-control.ts';
const own='anyraid-node-product-host.service',kernel='0::/system.slice/'+own;
const signal=()=>new AbortController().signal;
async function commandFixture(path:string,source:string){
 // A Node executable used as a CLI fixture must not inherit the test runner's
 // private child protocol; otherwise its stdout becomes runner messages.
 const js=path+'.cjs';await writeFile(js,source);const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
 await writeFile(path,'#!/bin/sh\nunset NODE_TEST_CONTEXT\nexec '+quote(process.execPath)+' '+quote(js)+' "$@"\n');await chmod(path,0o700);
}
function fixture(overrides:Partial<MachineControlIO>={}){
 const calls:string[][]=[];
 const control=new LinuxMachineControl({ownUnit:own,allowedUnits:['crowsnest.service','klipper-2.service','custom-device.service'],deviceUnits:['custom-device.service']},{readCgroup:async()=>kernel,insideContainer:async()=>false,command:async args=>{calls.push([...args]);return args.includes('show')?'Id='+args.at(-1)+'\nLoadState=loaded\n':'';},...overrides});
 return {control,calls};
}
test('service and OS commands use the canonical unit, noninteractive fixed argv and acknowledge only job submission',async()=>{
 const {control,calls}=fixture();
 try{
  for(const action of ['start','stop','restart'] as const){await control.execute({kind:'service',action,service:'crowsnest'},signal());assert.deepEqual(calls.at(-1),['--no-pager','--no-ask-password','--no-block',action,'--','crowsnest.service']);}
  await control.execute({kind:'server_restart'},signal());assert.deepEqual(calls.at(-1),['--no-pager','--no-ask-password','--no-block','restart','--',own]);
  await control.execute({kind:'reboot'},signal());assert.deepEqual(calls.at(-1),['--no-pager','--no-ask-password','--no-block','reboot']);
  await control.execute({kind:'shutdown'},signal());assert.deepEqual(calls.at(-1),['--no-pager','--no-ask-password','--no-block','poweroff']);
  assert.deepEqual(calls[0],['--no-pager','--no-ask-password','show','--property=Id,LoadState','--','crowsnest.service']);
 }finally{await control.close();}
});
test('scope distinguishes external dependencies, device units and process retirement without running commands',async()=>{
 const {control,calls}=fixture();
 try{assert.equal(control.retirement({kind:'service',action:'start',service:'crowsnest'}),'none');
  for(const service of ['klipper-2','custom-device'])assert.equal(control.retirement({kind:'service',action:'restart',service}),'device');
  for(const action of [{kind:'server_restart'},{kind:'reboot'},{kind:'shutdown'},{kind:'service',action:'restart',service:own.slice(0,-8)}] as MachineAction[])assert.equal(control.retirement(action),'process');
  for(const action of ['start','stop'] as const)await assert.rejects(control.execute({kind:'service',action,service:own.slice(0,-8)},signal()),error=>error instanceof MachineControlError&&error.code==='not_allowed');
  assert.equal(calls.length,0);
 }finally{await control.close();}
});
test('malformed scope, unit injection and request fields cannot create or extend the trusted capability',async()=>{
 for(const options of [{ownUnit:'--bad.service'},{ownUnit:own,allowedUnits:['a.service;poweroff']},{ownUnit:own,allowedUnits:['a.service','a.service']},{ownUnit:own,deviceUnits:['outside.service']},{ownUnit:own,allowedUnits:Array.from({length:64},(_,i)=>'x'+i+'.service')}])assert.throws(()=>new LinuxMachineControl(options));
 const {control,calls}=fixture();try{
  for(const value of [null,{},[],{kind:'service',action:'reload',service:'crowsnest'},{kind:'service',action:'start',service:'ssh'},{kind:'service',action:'start',service:'../crowsnest'},{kind:'service',action:'start',service:'--all'},{kind:'service',action:'start',service:'crowsnest.service'},{kind:'reboot',force:true},{kind:'service',action:'start',service:'crowsnest',unit:'ssh.service'}])await assert.rejects(control.execute(value as MachineAction,signal()),error=>error instanceof MachineControlError&&error.code==='not_allowed');
  assert.equal(calls.length,0);
 }finally{await control.close();}
});
test('kernel owner, container and canonical load checks reject before any system mutation',async()=>{
 for(const output of ['Id=alias.service\nLoadState=loaded\n','Id=crowsnest.service\nLoadState=not-found\n','Id=crowsnest.service\nLoadState=loaded\nLoadState=loaded\n','Id=crowsnest.service\nLoadState=loaded\nEnvironment=private\n','x'.repeat(65537)]){
  let mutations=0;const {control}=fixture({command:async args=>{if(!args.includes('show'))mutations++;return output;}});try{await assert.rejects(control.execute({kind:'service',action:'start',service:'crowsnest'},signal()),error=>error instanceof MachineControlError&&error.code==='unit');assert.equal(mutations,0);}finally{await control.close();}
 }
 const changed=fixture({readCgroup:async()=> '0::/system.slice/other.service'});try{await assert.rejects(changed.control.execute({kind:'server_restart'},signal()),error=>error instanceof MachineControlError&&error.code==='identity');assert.equal(changed.calls.length,0);}finally{await changed.control.close();}
 const container=fixture({insideContainer:async()=>true});try{for(const kind of ['reboot','shutdown'] as const)await assert.rejects(container.control.execute({kind},signal()),error=>error instanceof MachineControlError&&error.code==='container');assert.equal(container.calls.length,0);}finally{await container.control.close();}
});
test('request snapshot survives mutation while validation awaits; close aborts and joins pending work',async()=>{
 const kernelReady=Promise.withResolvers<string>();let observedSignal:AbortSignal|undefined;
 const {control,calls}=fixture({readCgroup:async s=>{observedSignal=s;return kernelReady.promise;}}),action:MachineAction={kind:'service',action:'start',service:'crowsnest'};
 const request=control.execute(action,signal());action.service='ssh';action.action='stop';await assert.rejects(control.execute({kind:'server_restart'},signal()),error=>error instanceof MachineControlError&&error.code==='busy');kernelReady.resolve(kernel);await request;assert.equal(calls.at(-1)?.at(-1),'crowsnest.service');assert.equal(calls.at(-1)?.[3],'start');await control.close();await assert.rejects(control.execute({kind:'reboot'},signal()),/closed/);
 const pending=Promise.withResolvers<string>(),other=fixture({readCgroup:async s=>{observedSignal=s;return pending.promise;}});const operation=other.control.execute({kind:'server_restart'},signal()),rejected=assert.rejects(operation,/closed/);await Promise.resolve();let closed=false;const closing=other.control.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(observedSignal?.aborted,true);assert.equal(closed,false);pending.resolve(kernel);await rejected;await closing;assert.equal(other.calls.length,0);
});
test('real command children are reaped on cancellation, timeout, output overflow and permission failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'machine-control-child-')),script=join(dir,'systemctl');
 const keys=['PATH','ANYRAID_MACHINE_TEST_PID','ANYRAID_MACHINE_TEST_MODE'],previous=new Map(keys.map(key=>[key,process.env[key]]));
 try{
  await commandFixture(script,'const fs=require("node:fs");fs.writeFileSync(process.env.ANYRAID_MACHINE_TEST_PID,String(process.pid));if(process.env.ANYRAID_MACHINE_TEST_MODE==="permission"){process.stderr.write("private diagnostic");process.exit(1);}process.on("SIGTERM",()=>{});if(process.env.ANYRAID_MACHINE_TEST_MODE==="overflow")process.stdout.write("x".repeat(70000));setInterval(()=>{},10000);\n');process.env.PATH=dir;
  for(const mode of ['cancel','timeout','overflow','permission']){
   const pidPath=join(dir,mode+'.pid');process.env.ANYRAID_MACHINE_TEST_PID=pidPath;process.env.ANYRAID_MACHINE_TEST_MODE=mode;
   const abort=new AbortController(),control=new LinuxMachineControl({ownUnit:own,allowedUnits:['crowsnest.service']},{readCgroup:async()=>kernel,insideContainer:async()=>false});
   const request=control.execute({kind:'service',action:'start',service:'crowsnest'},abort.signal),rejected=assert.rejects(request,mode==='cancel'?/closed/:error=>error instanceof MachineControlError&&error.code==='command'&&!error.message.includes('private'));
   try{
    let pid=0;const deadline=Date.now()+3000;while(!pid&&Date.now()<deadline){try{pid=Number(await readFile(pidPath,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(!pid)await delay(10);}assert(Number.isSafeInteger(pid)&&pid>0,'Command child must actually start');
    let watchdog=false;const cleanup=setTimeout(()=>{watchdog=true;try{process.kill(pid,'SIGKILL');}catch{}},3000);
    try{if(mode==='cancel')await control.close();await rejected;}finally{clearTimeout(cleanup);}
    assert.equal(watchdog,false);assert.throws(()=>process.kill(pid,0),(error:unknown)=>(error as NodeJS.ErrnoException).code==='ESRCH','Command completion must join child exit');
   }finally{await control.close();}
  }
 }finally{for(const key of keys){const value=previous.get(key);if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(dir,{recursive:true,force:true});}
});
test('device acquisition checks actual permitted hardware owners instead of assuming an accepted stop job finished',async()=>{
 let state='inactive',pid='0';const calls:string[][]=[];
 const {control}=fixture({command:async args=>{calls.push([...args]);return 'Id='+args.at(-1)+'\nLoadState=loaded\nActiveState='+state+'\nMainPID='+pid+'\n';}});
 try{
  await control.assertDeviceAvailable(signal());assert.deepEqual(calls.map(args=>args.at(-1)),['klipper-2.service','custom-device.service']);
  for(const active of ['active','activating','deactivating']){state=active;await assert.rejects(control.assertDeviceAvailable(signal()),error=>error instanceof MachineControlError&&error.code==='busy');}
  state='inactive';pid='123';await assert.rejects(control.assertDeviceAvailable(signal()),error=>error instanceof MachineControlError&&error.code==='busy');pid='0';await control.assertDeviceAvailable(signal());
 }finally{await control.close();}
});
test('default command runner executes successful inspection and mutation as separately reaped children',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'machine-control-success-')),script=join(dir,'systemctl'),log=join(dir,'argv.jsonl');const previousPath=process.env.PATH,previousLog=process.env.ANYRAID_MACHINE_TEST_LOG;
 try{
  await commandFixture(script,'const fs=require("node:fs");const args=process.argv.slice(2);fs.appendFileSync(process.env.ANYRAID_MACHINE_TEST_LOG,JSON.stringify({pid:process.pid,args})+"\\n");if(args.includes("show"))process.stdout.write("Id="+args.at(-1)+"\\nLoadState=loaded\\n");\n');process.env.PATH=dir;process.env.ANYRAID_MACHINE_TEST_LOG=log;
  const control=new LinuxMachineControl({ownUnit:own,allowedUnits:['crowsnest.service']},{readCgroup:async()=>kernel,insideContainer:async()=>false});
  try{await control.execute({kind:'service',action:'restart',service:'crowsnest'},signal());const rows=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(rows.length,2);assert.deepEqual(rows[1].args,['--no-pager','--no-ask-password','--no-block','restart','--','crowsnest.service']);assert.notEqual(rows[0].pid,rows[1].pid);for(const row of rows)assert.throws(()=>process.kill(row.pid,0),(e:unknown)=>(e as NodeJS.ErrnoException).code==='ESRCH');}finally{await control.close();}
 }finally{if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;if(previousLog===undefined)delete process.env.ANYRAID_MACHINE_TEST_LOG;else process.env.ANYRAID_MACHINE_TEST_LOG=previousLog;await rm(dir,{recursive:true,force:true});}
});
