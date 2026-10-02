import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createUsbFlashSystem,runUsbFlashCommand,waitUsbPath,type ReconnectClock} from '../src/diagnostics/flash-usb-system.ts';
import {UsbFlashExitError} from '../src/diagnostics/flash-usb.ts';
const signal=()=>new AbortController().signal;
test('USB filesystem adapters resolve real symlinks, sysfs interface and Katapult IDs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'usb-path-'));
 try{
  const by=join(root,'by-path'),ttyClass=join(root,'class'),tty=join(root,'ttyACM0'),usb=join(root,'usb1','1-2.3'),iface=join(usb,'1-2.3:1.0'),target=join(iface,'tty','ttyACM0');
  await mkdir(target,{recursive:true});await mkdir(by);await mkdir(ttyClass);await writeFile(tty,'');await symlink(target,join(ttyClass,'ttyACM0'));await symlink(iface,join(target,'device'));await symlink(tty,join(by,'stable'));await symlink(join(root,'absent'),join(by,'stale'));
  const io=createUsbFlashSystem({repository:root,serialByPath:by,ttyClass,enterBootloader:async()=>{},katapult:async()=>{}});
  assert.deepEqual(await io.serialPaths(tty,signal()),{tty,stable:join(by,'stable')});assert.deepEqual(await io.usbPath(tty,signal()),{busPath:'1-2.3',devicePath:iface});
  assert.equal(await io.isKatapult(iface,signal()),false);await writeFile(join(usb,'idVendor'),'1D50\n');await writeFile(join(usb,'idProduct'),'6177\n');assert.equal(await io.isKatapult(iface,signal()),true);
  await rm(join(by,'stable'));assert.deepEqual(await io.serialPaths(tty,signal()),{tty,stable:tty});
  const aborted=AbortSignal.abort(new Error('cancel'));await assert.rejects(io.isKatapult(iface,aborted),/cancel/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('USB reconnect uses monotonic deadline, stable alternative, and cancellation',async()=>{
 let now=0;const clock:ReconnectClock={now:()=>now,sleep:async(ms,s)=>{s.throwIfAborted();now+=ms;},exists:async p=>p==='alt'&&now!==400};
 assert.equal(await waitUsbPath('main','alt',signal(),clock),'alt');assert.equal(now,800);
 now=0;clock.exists=async()=>false;await assert.rejects(waitUsbPath('main',undefined,signal(),clock),/did not reconnect/);assert.equal(now,4100);
 now=0;clock.exists=async()=>true;assert.equal(await waitUsbPath('main',undefined,signal(),clock),'main');assert.equal(now,300);
 await assert.rejects(waitUsbPath('main',undefined,AbortSignal.abort(new Error('cancel')),clock),/cancel/);
});
test('USB process execution preserves argv and cwd, distinguishes exits and cancels live writer',async()=>{
 const root=await mkdtemp(join(tmpdir(),'usb-run-'));
 try{
  const out=join(root,'out.json'),arg='$(touch nope); space " x';
  await runUsbFlashCommand([process.execPath,'-e','require("fs").writeFileSync(process.argv[1],JSON.stringify({cwd:process.cwd(),arg:process.argv[2]}))',out,arg],root,signal());assert.deepEqual(JSON.parse(await readFile(out,'utf8')),{cwd:root,arg});
  await assert.rejects(runUsbFlashCommand([process.execPath,'-e','process.exit(7)'],root,signal()),e=>e instanceof UsbFlashExitError&&e.exitCode===7);
  await assert.rejects(runUsbFlashCommand([join(root,'absent')],root,signal()),{code:'ENOENT'});
  const ready=join(root,'ready'),controller=new AbortController();const pending=runUsbFlashCommand([process.execPath,'-e','process.on("SIGTERM",()=>{});require("fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},100)',ready],root,controller.signal);const rejected=assert.rejects(pending,/cancel writer/);
  for(let i=0;;i++){try{await readFile(ready);break;}catch{if(i>200)throw new Error('writer not ready');await delay(10);}}
  const pid=Number(await readFile(ready,'utf8'));controller.abort(new Error('cancel writer'));await rejected;assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }finally{await rm(root,{recursive:true,force:true});}
});
