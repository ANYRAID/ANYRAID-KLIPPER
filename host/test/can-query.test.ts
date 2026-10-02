import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {decodeCanDiscovery,queryCanDevices,openCanDiscovery,type CanDiscoveryFrame} from '../src/diagnostics/can-query.ts';
const frame=(bytes:number[],id=0x3f1):CanDiscoveryFrame=>({id,data:Uint8Array.from(bytes)});
test('CAN discovery preserves six-byte UUIDs and all application mappings',()=>{
 assert.deepEqual(decodeCanDiscovery(frame([32,0,0,0,0,0,0])),{uuid:'000000000000',application:'Klipper'});
 assert.deepEqual(decodeCanDiscovery(frame([32,255,255,255,255,255,255,17])),{uuid:'ffffffffffff',application:'CanBoot'});
 assert.equal(decodeCanDiscovery(frame([32,17,170,34,187,51,204,99]))?.application,'Unknown');
 for(const f of [frame([32]),frame([1,1,2,3,4,5,6]),frame([32,1,2,3,4,5,6],0x3f0),frame([32,1,2,3,4,5,6],0x800003f1),frame([32,1,2,3,4,5,6],0x400003f1),frame([32,1,2,3,4,5,6],0x200003f1),frame([32,1,2,3,4,5,6,1,2])])assert.equal(decodeCanDiscovery(f),undefined);
});
test('CAN query sends once, retains first application and closes on monotonic deadline',async()=>{
 let time=0,sent=0,closed=0;const frames=[frame([32,1,2,3,4,5,6]),frame([32,1,2,3,4,5,6,17]),frame([32,6,5,4,3,2,1,17])];
 const got=await queryCanDevices({sendQuery(){sent++;},read(){return frames.shift()??null;},close(){closed++;}},new AbortController().signal,{durationMs:5,now:()=>time,wait:async ms=>{time+=ms;}});
 assert.deepEqual(got,[{uuid:'010203040506',application:'Klipper'},{uuid:'060504030201',application:'CanBoot'}]);assert.equal(sent,1);assert.equal(closed,1);assert.equal(time,5);
});
test('CAN query yields under floods and honors cancellation without resending',async()=>{
 let reads=0,closed=0,sent=0;const control=new AbortController();
 await assert.rejects(queryCanDevices({sendQuery(){sent++;},read(){reads++;return frame([32,1,2,3,4,5,6]);},close(){closed++;}},control.signal,{now:()=>0,wait:async()=>{control.abort(new Error('cancel flood'));}}),/cancel flood/);
 assert.equal(reads,256);assert.equal(sent,1);assert.equal(closed,1);
});
test('CAN query closes on pre-abort, limits, transport and clock faults',async()=>{
 for(const mode of ['abort','limit','send','read','clock','options']){
  let closed=0,n=0,ticks=0;const control=new AbortController();if(mode==='abort')control.abort(new Error('pre-abort'));
  const channel={sendQuery(){if(mode==='send')throw new Error('send failed');},read(){if(mode==='read')throw new Error('read failed');return frame([32,0,0,0,0,0,++n]);},close(){closed++;}};
  await assert.rejects(queryCanDevices(channel,control.signal,{maximumDevices:1,durationMs:mode==='options'?0:2,now:()=>mode==='clock'?-(ticks++):0,wait:async()=>{}}));assert.equal(closed,1);
 }
});
test('CAN native API rejects invalid handles and interfaces; CLI help needs no hardware',()=>{
 const native=createRequire(import.meta.url)(process.env.ANYRAID_CAN_QUERY_ADDON??'../build/can-query.node');
 for(const value of [null,{},1,'can0'])for(const method of ['read','sendQuery','close'])assert.throws(()=>native[method](value),/Invalid CAN channel/);
 for(const name of ['', 'a'.repeat(16),'can\0bad'])assert.throws(()=>native.open(name),/Invalid CAN interface/);
 assert.throws(()=>openCanDiscovery('../can0'),/Invalid CAN interface/);
 assert.throws(()=>openCanDiscovery('zznoexist987'),/Find CAN interface/);
 const help=spawnSync(process.execPath,['scripts/canbus_query.ts','--help'],{cwd:new URL('../../',import.meta.url),encoding:'utf8'});assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/active print/);
});
