import test from 'node:test';
import assert from 'node:assert/strict';
import {compileSDIO,sessionSDIO,sdioFormats} from '../src/diagnostics/sdio-mcu.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {encodeFrame} from '../src/protocol/codec.ts';
import type {SerialSession} from '../src/protocol/serial-session.ts';
const signal=()=>new AbortController().signal;
function fixture(){
 const dictionary=new MessageDictionary(),commands:Record<string,number>={},responses:Record<string,number>={};let id=2;
 for(const [key,format] of Object.entries(sdioFormats))(key.endsWith('Response')?responses:commands)[format]=id++;
 dictionary.identify(Buffer.from(JSON.stringify({commands,responses,enumerations:{sdio_bus:{sdio:0}},config:{}})),false);
 const buffer=new Uint8Array(512),writes:{address:number;data:Uint8Array}[]=[],events:string[]=[];let stopped=false,stops=0,fault='',commandError=0;
 const decode=(payload:Uint8Array)=>dictionary.parseFrame(encodeFrame(0x10,payload))[0];
 const queue={async send(payload:Uint8Array,_min:bigint,_req:bigint,s:AbortSignal){s.throwIfAborted();const m=decode(payload);events.push(m.name);if(m.name==='sdio_write_data_buffer')buffer.set(m.parameters.data as Uint8Array,m.parameters.offset as number);}};
 const fake={dictionary,assertActive(){if(stopped)throw new Error('closed');},commandQueue(){return queue;},async stop(){stopped=true;stops++;},async queryOnQueue(q:unknown,payload:Uint8Array,name:string,s:AbortSignal,options:any){
  assert.equal(q,queue);assert.equal(options.retries,0);s.throwIfAborted();const m=decode(payload),p=m.parameters;events.push(m.name);let parameters:Record<string,number|Uint8Array>={oid:0};
  if(m.name==='sdio_send_command')parameters={...parameters,error:commandError,response:new Uint8Array(p.wait===2?16:p.wait===1?4:0)};
  if(m.name==='sdio_read_data'){for(let i=0;i<512;i++)buffer[i]=(i+(p.argument as number))&255;parameters={...parameters,error:fault==='error'?1:0,read:fault==='count'?511:512};}
  if(m.name==='sdio_read_data_buffer')parameters={...parameters,data:buffer.slice(p.offset as number,(p.offset as number)+(fault==='buffer'?31:32))};
  if(m.name==='sdio_write_data'){writes.push({address:p.argument as number,data:buffer.slice()});parameters={...parameters,error:0,write:512};}
  if(fault==='route')parameters.oid=1;
  return {message:{name,parameters},sentTime:0,receiveTime:0};
 }};
 return {dictionary,queue,session:fake as unknown as SerialSession,writes,events,get stops(){return stops;},set fault(value:string){fault=value;},set commandError(value:number){commandError=value;}};
}
test('SDIO configuration matches firmware formats and rejects unknown buses',()=>{
 const f=fixture(),plan=compileSDIO(f.dictionary,0,'sdio');assert.equal(plan.config,'config_sdio oid=0 blocksize=512');assert.equal(plan.configureBus,'sdio_set_bus oid=0 sdio_bus=sdio');assert.throws(()=>compileSDIO(f.dictionary,0,'missing'));assert.throws(()=>compileSDIO(f.dictionary,255,'sdio'));
});
test('SDIO buffer transactions serialize complete sectors and copy queued payloads',async t=>{
 const f=fixture(),device=sessionSDIO(f.session,0);assert.equal(device,sessionSDIO(f.session,0));const data=new Uint8Array(512).fill(7),first=device.writeSector(0xffffffff,data,signal());data.fill(8);
 const second=device.writeSector(2,data,signal()),third=device.readSector(3,signal());await Promise.all([first,second]);assert.equal((await third)[0],3);assert.equal(f.writes[0].address,0xffffffff);assert(f.writes[0].data.every(b=>b===7));assert(f.writes[1].data.every(b=>b===8));
 assert.deepEqual(f.events.slice(0,17),[...Array(16).fill('sdio_write_data_buffer'),'sdio_write_data']);assert.equal(f.stops,0);
 const samples:number[]=[];for(let i=0;i<12;i++){const start=performance.now();await device.writeSector(i,data,signal());await device.readSector(i,signal());if(i>=2)samples.push(performance.now()-start);}samples.sort((a,b)=>a-b);t.diagnostic(JSON.stringify({scope:'Dictionary encoding and in-memory MCU SDIO buffer; excludes native UART and card latency',samples:10,warmups:2,medianMs:samples[5],maxMs:samples[9]}));
});
test('SDIO rejects incomplete sectors, buffer replies, error codes and wrong OIDs',async()=>{
 for(const fault of ['count','buffer','error','route']){const f=fixture(),device=sessionSDIO(f.session,0);f.fault=fault;await assert.rejects(device.readSector(0,signal()));assert.equal(f.stops,1);await assert.rejects(device.readSector(0,signal()),/closed/);}
});
test('SDIO preserves initialization error codes but rejects invalid requests without IO',async()=>{
 const f=fixture(),device=sessionSDIO(f.session,0);f.commandError=4;assert.equal((await device.command(41,0xc1100000,1,signal())).error,4);assert.equal(f.stops,0);
 const count=f.events.length;assert.throws(()=>device.command(64,0,1,signal()));assert.throws(()=>device.readSector(2**32,signal()));assert.throws(()=>device.writeSector(0,new Uint8Array(513),signal()));assert.throws(()=>device.speed(0,signal()));await assert.rejects(device.readSector(0,AbortSignal.abort(new Error('cancel'))),/cancel/);assert.equal(f.events.length,count);
});

test('SDIO cancellation during buffer upload never issues the card write command',async()=>{
 const f=fixture(),controller=new AbortController(),send=f.queue.send.bind(f.queue);
 f.queue.send=async(...args)=>{await send(...args);controller.abort(new Error('cancel upload'));};
 const device=sessionSDIO(f.session,0);await assert.rejects(device.writeSector(0,new Uint8Array(512),controller.signal),/cancel upload/);
 assert.deepEqual(f.events,['sdio_write_data_buffer']);assert.equal(f.writes.length,0);assert.equal(f.stops,1);
});
