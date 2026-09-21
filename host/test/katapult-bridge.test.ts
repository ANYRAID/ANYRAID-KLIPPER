import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {katapultFastHash64,usbSerialToCanUuid,findKatapultBridge,waitKatapultBridge} from '../src/diagnostics/katapult-bridge.ts';
import {katapultHashReference} from '../bench/katapult-hash-reference.ts';
const signal=()=>new AbortController().signal;
test('BigInt fasthash and byte-swapped UUID match frozen original Python through 64-bit boundaries and every tail length',()=>{
 const cases=Array.from({length:65},(_,length)=>[0n,1n,0xffffffffffffffffn,0xa16231a7n].map(seed=>({hex:Buffer.from(Array.from({length},(_,i)=>(i*137+length*41)&255)).toString('hex'),seed:String(seed)}))).flat();cases.push({hex:' \t00 ff\n12AB\r',seed:'2711761319'});
 const reference=katapultHashReference(cases);for(const [i,c] of cases.entries()){assert.equal(katapultFastHash64(Buffer.from(c.hex.replace(/\s/g,''),'hex'),BigInt(c.seed)).toString(16).padStart(16,'0'),reference.hashes[i]);assert.equal(usbSerialToCanUuid(c.hex),reference.uuids[i]);}
 for(const serial of ['a','a a','gg','0x12','00\u00a0ff','00'.repeat(513)])assert.throws(()=>usbSerialToCanUuid(serial));assert.throws(()=>katapultFastHash64(Buffer.alloc(1),-1n));assert.throws(()=>katapultFastHash64(Buffer.alloc(1),1n<<64n));
});
async function fixture(){const base=await mkdtemp(join(tmpdir(),'katapult-bridge-')),usb=join(base,'usb'),dev=join(base,'dev');await mkdir(usb);await mkdir(dev);return {base,usb,dev};}
async function device(usb:string,name:string,serial='112233445566778899aabbcc'){
 const path=join(usb,name);await mkdir(join(path,name+':1.0','net','can0'),{recursive:true});for(const [key,value] of Object.entries({bDeviceClass:'00',idVendor:'1D50',idProduct:'606F',manufacturer:'Klipper',serial}))await writeFile(join(path,key),value+'\n');return path;
}
test('bridge discovery requires interface, GS USB identity and exact UUID; duplicate matches fail',async()=>{
 const f=await fixture();try{const path=await device(f.usb,'1-2'),uuid=usbSerialToCanUuid('112233445566778899aabbcc');assert.deepEqual(await findKatapultBridge('can0',uuid,signal(),f),{path,uuid,serial:'112233445566778899aabbcc'});assert.equal(await findKatapultBridge('can1',uuid,signal(),f),undefined);assert.equal(await findKatapultBridge('can0','000000000000',signal(),f),undefined);await device(f.usb,'1-3');await assert.rejects(findKatapultBridge('can0',uuid,signal(),f),/Ambiguous/);}finally{await rm(f.base,{recursive:true,force:true});}
});
test('bridge reconnect returns unique new tty and rejects timeout, wrong product, ambiguity and cancellation',async()=>{
 const f=await fixture();try{const path=await device(f.usb,'1-2'),bridge={path,uuid:'000000000000',serial:'00'};let polls=0;
  const clock={async sleep(_ms:number,s:AbortSignal){s.throwIfAborted();polls++;}};
  await assert.rejects(waitKatapultBridge(bridge,signal(),f,clock),/timed out/);assert.equal(polls,8);
  await writeFile(join(path,'idProduct'),'6177');await writeFile(join(path,'manufacturer'),'Katapult');await mkdir(join(path,'1-2:1.0','tty','ttyACM4'),{recursive:true});await writeFile(join(f.dev,'ttyACM4'),'');assert.equal(await waitKatapultBridge(bridge,signal(),f,clock),join(f.dev,'ttyACM4'));
  await mkdir(join(path,'1-2:1.0','tty','ttyACM5'));await assert.rejects(waitKatapultBridge(bridge,signal(),f,clock),/ambiguous/);await rm(join(path,'1-2:1.0','tty','ttyACM5'),{recursive:true});
  await writeFile(join(path,'idProduct'),'ffff');await writeFile(join(path,'manufacturer'),'other');await assert.rejects(waitKatapultBridge(bridge,signal(),f,clock),/did not reconnect/);
  await assert.rejects(waitKatapultBridge(bridge,AbortSignal.abort(new Error('cancel')),f,clock),/cancel/);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
