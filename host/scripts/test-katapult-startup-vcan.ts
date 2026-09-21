import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readlinkSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {flashKatapultTarget} from '../src/diagnostics/katapult-startup.ts';
import {usbSerialToCanUuid} from '../src/diagnostics/katapult-bridge.ts';
import {katapultSimulator} from '../bench/katapult-reference.ts';
import {katapultPTY} from '../test/helpers/katapult-pty.ts';
const script=fileURLToPath(import.meta.url),host=fileURLToPath(new URL('..',import.meta.url));
function env(){const out={...process.env};delete out.LD_PRELOAD;delete out.ASAN_OPTIONS;return out;}
function command(name:string,args:string[]){const r=spawnSync(name,args,{env:env(),encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr||String(r.error));}
function bridgeFixture(){
 const base=mkdtempSync(resolve(tmpdir(),'bridge-switch-')),usb=resolve(base,'usb'),dev=resolve(base,'dev'),path=resolve(usb,'1-2'),serial='112233445566778899aabbcc',pty=katapultPTY({prime:true});
 mkdirSync(resolve(path,'1-2:1.0/net/vcan-test'),{recursive:true});mkdirSync(resolve(path,'1-2:1.0/tty/ttyACM9'),{recursive:true});mkdirSync(dev);symlinkSync(pty.path,resolve(dev,'ttyACM9'));
 for(const [key,value] of Object.entries({bDeviceClass:'00',idVendor:'1d50',idProduct:'606f',manufacturer:'klipper',serial,product:'stm32f103'}))writeFileSync(resolve(path,key),value);
 return {base,usb,dev,path,pty,uuid:usbSerialToCanUuid(serial)};
}
async function inside(executable:string){
 assert.ok(process.env.KATAPULT_PARENT_NET&&process.env.KATAPULT_PARENT_USER);assert.notEqual(readlinkSync('/proc/self/ns/net'),process.env.KATAPULT_PARENT_NET);assert.notEqual(readlinkSync('/proc/self/ns/user'),process.env.KATAPULT_PARENT_USER);
 command('ip',['link','add','dev','vcan-test','type','vcan']);command('ip',['link','set','dev','vcan-test','up']);
 const samples:number[]=[];
 for(const mode of [...Array.from({length:16},()=> 'startup'),'startup-cancel','bridge','bridge-wrong','bridge-cancel']){
  const bridge=mode.startsWith('bridge')?bridgeFixture():undefined,uuid=bridge?.uuid??'112233445566',controller=new AbortController();
  const peer=spawn(executable,[uuid,'reboot'],{env:env(),stdio:['pipe','pipe','pipe']}),sim=katapultSimulator(256),seen:number[]=[];
  let diagnostic='',buffer:Buffer=Buffer.alloc(0),chain=Promise.resolve(),fault:unknown,timer:ReturnType<typeof setTimeout>|undefined;
  peer.stderr.on('data',b=>{diagnostic+=b;if(mode==='startup-cancel'&&diagnostic.includes('REBOOT\n'))controller.abort(new Error('cancel startup'));if(bridge&&diagnostic.includes('REBOOT\n')){writeFileSync(resolve(bridge.path,'idProduct'),mode==='bridge-wrong'?'ffff':'6177');writeFileSync(resolve(bridge.path,'manufacturer'),mode==='bridge-wrong'?'other':'katapult');if(mode==='bridge-cancel')controller.abort(new Error('cancel bridge'));}});
  peer.stdin.on('error',()=>{});const ended=new Promise<number|null>((resolve,reject)=>{peer.once('error',reject);peer.once('close',resolve);});void ended.catch(()=>{});
  peer.stdout.on('data',(bytes:Buffer)=>{buffer=Buffer.concat([buffer,bytes]);while(buffer.length>=4){const length=buffer[3]*4+8;if(buffer.length<length)break;const frame=Buffer.from(buffer.subarray(0,length));buffer=buffer.subarray(length);seen.push(frame[2]);chain=chain.then(async()=>{peer.stdin.write(await sim.transport.exchange(frame,2000,new AbortController().signal));}).catch(error=>{fault=error;});}});
  try{
   const deadline=performance.now()+3000;while(!diagnostic.includes('READY\n')){assert.equal(peer.exitCode,null,diagnostic);assert.ok(performance.now()<deadline);await delay(1);}
   const at=performance.now(),work=flashKatapultTarget('vcan-test',uuid,Buffer.alloc(4093,0xa5),controller.signal,{expectedMcu:'stm32f407',roots:bridge?{usb:bridge.usb,dev:bridge.dev}:undefined});
   if(mode==='bridge-wrong'||mode.endsWith('cancel')){await assert.rejects(work);assert.equal(seen.length,0);if(bridge)assert.equal(bridge.pty.commands.length,0);}
   else{const result=await work;assert.equal(result.blocks,16);assert.equal(result.transport,bridge?'serial':'can');if(bridge){assert.equal(seen.length,0);assert.equal(bridge.pty.commands[0],0x90);assert.equal(bridge.pty.commands.at(-1),0x15);}else{samples.push(performance.now()-at);assert.equal(seen[1],0x16);assert.equal(seen.at(-1),0x15);assert.equal(seen.length,36);}}
   assert.equal((diagnostic.match(/REBOOT/g)||[]).length,1);assert.equal((diagnostic.match(/ASSIGNED/g)||[]).length,bridge||mode==='startup-cancel'?0:1);assert.equal(fault,undefined);
  }finally{clearTimeout(timer);await chain;peer.stdin.end();const kill=setTimeout(()=>peer.kill('SIGKILL'),2000);try{assert.equal(await ended,0,diagnostic);}finally{clearTimeout(kill);if(bridge){await bridge.pty.close();rmSync(bridge.base,{recursive:true,force:true});}}}
 }
 const s=samples.slice(5).sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,warmup:5,runs:11,imageBytes:4093,medianMs:s[5],p95Ms:s[10],scope:'Exact targeted reboot, original 1000 ms boot wait + 500 ms assignment settle, then complete real vcan/simulated firmware flash. Bridge uses temporary sysfs plus real PTY. No physical reboot, USB or flash timing.'}));
 console.log('PASS: targeted CAN reboot/flash, bridge-to-PTY programming, wrong bridge and cancellation with no fallback');
}
if(process.argv[2]==='--inside')await inside(process.argv[3]);else{
 const temporary=mkdtempSync(resolve(tmpdir(),'katapult-startup-vcan-'));try{const peer=resolve(temporary,'bridge');command(process.env.CC??'cc',['-O2','-Wall','-Wextra','-Werror',resolve(host,'test/fixtures/katapult-can-bridge.c'),'-o',peer]);const r=spawnSync('unshare',['--user','--map-root-user','--net','env',`LD_PRELOAD=${process.env.LD_PRELOAD??''}`,`ASAN_OPTIONS=${process.env.ASAN_OPTIONS??''}`,process.execPath,script,'--inside',peer],{env:{...env(),KATAPULT_PARENT_NET:readlinkSync('/proc/self/ns/net'),KATAPULT_PARENT_USER:readlinkSync('/proc/self/ns/user')},stdio:'inherit',timeout:45000});assert.equal(r.status,0,String(r.error||r.signal));}finally{rmSync(temporary,{recursive:true,force:true});}
}
