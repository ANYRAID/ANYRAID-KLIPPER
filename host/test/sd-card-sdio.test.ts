import test from 'node:test';
import assert from 'node:assert/strict';
import {SDCardSDIO,sdNativeStatus} from '../src/diagnostics/sd-card-sdio.ts';
import {sdCRC7} from '../src/diagnostics/sd-card-spi.ts';
import type {SDIOTransport} from '../src/diagnostics/sdio-mcu.ts';
import {SDCardEmulator} from './helpers/sd-card-spi.ts';
const signal=()=>new AbortController().signal;
function fixture(high=true){
 const reg=new SDCardEmulator(high),commands:{cmd:number;arg:number}[]=[],writes:{address:number;data:Uint8Array}[]=[],speeds:number[]=[];let ocrError=4,failure=-1,busy=0,locked=false;
 const word=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
 const io:SDIOTransport={
  async command(cmd,arg,wait,s){s.throwIfAborted();commands.push({cmd,arg});if(cmd===failure)return {error:1,response:word(0)};
   if(cmd===8&&!high)return {error:3,response:new Uint8Array()};
   if(cmd===41)return {error:ocrError,response:word(high?0xc0300000:0x80300000)};
   if(cmd===2||cmd===9){const r=(cmd===2?reg.cid:reg.csd).slice();r[15]&=254;return {error:0,response:r};}
   const value=cmd===8?0x10a:cmd===55?0x20:cmd===3?0xabcd0000:cmd===13?(locked?0x02000900:busy-->0?0xe00:0x900):0x900;
   return {error:0,response:wait?word(value):new Uint8Array()};
  },
  async speed(hz,s){s.throwIfAborted();speeds.push(hz);},
  async readSector(address,s){s.throwIfAborted();return new Uint8Array(512).fill(address&255);},
  async writeSector(address,data,s){s.throwIfAborted();writes.push({address,data:data.slice()});},
 };
 return {io,reg,commands,writes,speeds,set ocrError(n:number){ocrError=n;},set failure(n:number){failure=n;},set busy(n:number){busy=n;},set locked(b:boolean){locked=b;}};
}
for(const high of [false,true])test(`SDIO ${high?'V2':'V1'} lifecycle uses native addresses, fixed voltage and confirmed write state`,async()=>{
 const f=fixture(high),card=new SDCardSDIO(f.io),info=await card.initialize(signal());assert.equal(info.version,high?2:1);assert.equal(info.sectors,4096);assert.equal(info.highCapacity,high);assert.equal(info.revision,'1.2');assert.deepEqual(f.speeds,[400000,1000000]);
 assert(f.commands.filter(c=>c.cmd===41).every(c=>c.arg===(high?0x40300000:0x00300000)));assert.equal(f.commands.find(c=>c.cmd===9)?.arg,0xabcd0000);
 const data=new Uint8Array([1,2]),write=card.writeSector(2,data,signal());data.fill(9);f.busy=1;await write;assert.equal(f.writes[0].address,high?2:1024);assert.deepEqual([...f.writes[0].data.slice(0,3)],[1,2,0]);
 assert((await card.readSector(3,signal())).every(b=>b===(high?3:0)));await card.deinitialize(signal());assert.equal(card.info,undefined);await assert.rejects(card.readSector(0,signal()),/not initialized/);
});
test('native status uses bits 12:9 for transfer state and bit 8 for readiness',()=>{
 assert.deepEqual(sdNativeStatus(Uint8Array.from([0,0,9,0])),{state:4,ready:true,app:false});
 assert.deepEqual(sdNativeStatus(Uint8Array.from([0,0,14,0])),{state:7,ready:false,app:false});
 for(const bit of [31,30,29,28,27,26,25,24,23,22,21,20,19,16,15,13,3]){const b=Buffer.alloc(4);b.writeUInt32BE(2**bit);assert.throws(()=>sdNativeStatus(b),/status error/);}
});
test('SDIO permits R3 CRC/index exception only for OCR, rejects other errors and invalid registers',async()=>{
 for(const error of [0,4,5]){const f=fixture(),card=new SDCardSDIO(f.io);f.ocrError=error;await card.initialize(signal());assert(card.info);}
 for(const cmd of [8,55,2,3,9,7,16]){const f=fixture(),card=new SDCardSDIO(f.io);f.failure=cmd;await assert.rejects(card.initialize(signal()));assert.equal(card.info,undefined);assert.equal(f.writes.length,0);}
 const f=fixture();f.reg.cid[0]^=1;await assert.rejects(new SDCardSDIO(f.io).initialize(signal()),/CRC/);
});
test('SDIO rejects write protection and never reports a locked card write as success',async()=>{
 const f=fixture(),card=new SDCardSDIO(f.io);f.reg.csd[14]=0x30;f.reg.csd[15]=sdCRC7(f.reg.csd.subarray(0,15));await card.initialize(signal());await assert.rejects(card.writeSector(0,new Uint8Array(),signal()),/protected/);assert.equal(f.writes.length,0);
 const g=fixture(),other=new SDCardSDIO(g.io);await other.initialize(signal());g.locked=true;await assert.rejects(other.writeSector(0,new Uint8Array(),signal()),/status error/);assert.equal(other.info,undefined);
});
test('SDIO card sequencing overhead includes status confirmation on every write',async t=>{
 const f=fixture(),card=new SDCardSDIO(f.io);await card.initialize(signal());const times:number[]=[];
 for(let batch=0;batch<9;batch++){const start=performance.now();for(let i=0;i<256;i++){await card.readSector(i,signal());await card.writeSector(i,new Uint8Array(512),signal());}if(batch>=2)times.push(performance.now()-start);}
 times.sort((a,b)=>a-b);assert.equal(f.writes.length,9*256);t.diagnostic(JSON.stringify({node:process.version,warmups:2,samples:7,sectorsRead:256,sectorsWritten:256,medianMs:times[3],maxMs:times[6],scope:'Card lifecycle with in-memory transport and write status confirmation; no MCU or card latency'}));
});
