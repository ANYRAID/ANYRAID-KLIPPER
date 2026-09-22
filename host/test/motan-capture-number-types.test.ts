import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer,type Socket} from 'node:net';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {parseTypedMotanJson,cloneMotanJson,mergeMotanObjects,assignMotanObject,MotanNumberMetadataError} from '../src/motan/number-types.ts';
import {encodeMotanJson,MotanCapture} from '../src/motan/capture.ts';
import {captureMotan} from '../src/motan/data-logger.ts';
import {MotanLogManager} from '../src/motan/log-manager.ts';
import {MotanStatusTracker} from '../src/motan/dispatch.ts';
import {ConsoleFrames} from '../src/diagnostics/webhook-console.ts';
const shapeScript=`import json,sys,struct
x=json.load(sys.stdin)
def shape(v):
 if type(v)==int: return ['int',str(v)]
 if type(v)==float: return ['float',struct.pack('>d',v).hex()]
 if type(v)==list: return [shape(i) for i in v]
 if type(v)==dict: return {k:shape(i) for k,i in v.items()}
 return v
print(json.dumps([shape(json.loads(s)) for s in x]))`;
function pythonShapes(texts:string[]):unknown[]{return JSON.parse(execFileSync('python3',['-c',shapeScript],{input:JSON.stringify(texts),encoding:'utf8'}));}
test('Motan serialization retains integer versus float kind and exact Float64 bits through copies and capture assignments',()=>{
 const source='{"i":1,"f":1.0,"e":1e0,"iz":-0,"fz":-0.0,"large":1e20,"exp":1e21,"tiny":5e-324,"wide":9007199254740993,"rounded":9007199254740993.0,"nested":{"a":[1,1.0,1e0,-0.0]},"__proto__":2.0}';
 const value=parseTypedMotanJson(source) as Record<string,unknown>,owned:Record<string,unknown>=Object.create(null);assignMotanObject(owned,value);
 const copies=[value,cloneMotanJson(value),mergeMotanObjects({},value),owned].map(v=>encodeMotanJson(v).toString());
 const expected=pythonShapes([source,...copies]);for(const actual of expected.slice(1))assert.deepEqual(actual,expected[0]);
 const values=[-0,0,1,Number.MIN_VALUE,Number.MAX_VALUE],bits=Buffer.alloc(8);let seed=731;
 const random=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 while(values.length<5000){bits.writeUInt32BE(random(),0);bits.writeUInt32BE(random(),4);const n=bits.readDoubleBE();if(Number.isFinite(n))values.push(n);}
 const literal=(n:number)=>Object.is(n,-0)?'-0.0':/[.eE]/.test(String(n))?String(n):String(n)+'.0';
 const text='['+values.map(literal).join(',')+']',encoded=encodeMotanJson(parseTypedMotanJson(text)).toString(),roundtrip=pythonShapes([text,encoded]);
 assert.deepEqual(roundtrip[1],roundtrip[0]);
 assignMotanObject(owned,parseTypedMotanJson('{"i":1.0,"f":1,"__proto__":null}') as Record<string,unknown>);
 const changed=encodeMotanJson(owned).toString();assert.match(changed,/"i":1\.0/);assert.match(changed,/"f":1,/);assert.equal(({} as Record<string,unknown>).i,undefined);
 assignMotanObject(owned,{i:1});assert.match(encodeMotanJson(owned).toString(),/"i":1,/);
 value.f=2;assert.throws(()=>encodeMotanJson(value),/Mutated/);
});
test('real capture preserves status numeric kinds in initial and delta indexes and typed seek sampling',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-capture-types-')),socketPath=join(dir,'socket'),prefix=join(dir,'capture'),raw:Buffer[]=[];
 const initial='{"toolhead":{"estimated_print_time":10.0},"configfile":{"settings":{"printer":{"kinematics":"cartesian"}}},"motion_report":{"trapq":[],"steppers":[]},"sensor":{"integer":1,"floating":1.0,"zero":-0,"negative":-0.0,"exponent":1e0,"large":1e20,"wide":9007199254740993,"nest":{"a":[1,1.0,1e0]}}}';
 const changes=['{"toolhead":{"estimated_print_time":12.0},"sensor":{"integer":1.0,"floating":1}}','{"toolhead":{"estimated_print_time":16.0},"sensor":{"integer":2.0,"zero":0.0,"large":1e21}}'];
 let peer:Socket|undefined;
 const server=createServer(socket=>{peer=socket;const frames=new ConsoleFrames(3);socket.on('data',chunk=>{
  for(const frame of frames.push(Buffer.from(chunk))){const request=JSON.parse(frame.toString());
   let text:string;if(request.id==='info')text='{"id":"info","result":{"state":"ready"}}';
   else if(request.id==='list')text='{"id":"list","result":{"objects":["configfile","motion_report","toolhead","sensor"]}}';
   else text='{"id":"status","result":{"eventtime":10.0,"status":'+initial+'}}';
   const reply=Buffer.from(text+'\x03');raw.push(reply);socket.write(reply);
   if(request.id==='status'){const updates=changes.map((status,i)=>Buffer.from('{"q":"status","params":{"eventtime":'+(i?16:12)+'.0,"status":'+status+'}}\x03'));raw.push(...updates);socket.end(Buffer.concat(updates));}
  }
 });});
 try{
  server.listen(socketPath);await once(server,'listening');await captureMotan(socketPath,prefix,[],new AbortController().signal,()=>{});
  assert.deepEqual(gunzipSync(await readFile(prefix+'.json.gz')),Buffer.concat(raw));
  const indexes=gunzipSync(await readFile(prefix+'.index.gz')).toString().split('\x03').filter(Boolean);assert.equal(indexes.length,2);
  const comparison=execFileSync('python3',['-c',shapeScript.replace("print(json.dumps([shape(json.loads(s)) for s in x]))",`initial=json.loads(x['initial']);delta={}
for raw in x['changes']:
 for key,value in json.loads(raw).items(): delta.setdefault(key,{}).update(value)
expected=[shape(initial),shape(delta)]
actual=[shape(json.loads(s)['status']) for s in x['indexes']]
assert actual==expected
print('exact')`)],{input:JSON.stringify({initial,changes,indexes}),encoding:'utf8'});
  assert.equal(comparison.trim(),'exact');
  const manager=await MotanLogManager.open(prefix,{start:7,reader:{preserveNumberTypes:true}});
  try{
   assert.ok(manager.filePosition>0);const names=['integer','floating','zero','negative','exponent','large','wide'];
   for(const name of names)manager.addDataset(`status(sensor.${name})`);
   const values=await manager.sample(17);
   assert.equal(values['status(sensor.integer)'],2);assert.equal(values['status(sensor.floating)'],1n);
   assert.ok(Object.is(values['status(sensor.zero)'],0));assert.ok(Object.is(values['status(sensor.negative)'],-0));
   assert.equal(values['status(sensor.exponent)'],1);assert.equal(values['status(sensor.large)'],1e21);assert.equal(values['status(sensor.wide)'],9007199254740993n);
  }finally{await manager.close();}
 }finally{peer?.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});

test('typed status byte budget includes float spelling and updates exactly at the boundary',async()=>{
 const initial=parseTypedMotanJson('{"sensor":{"f":1.0,"i":-0,"array":[1.0,1]}}') as Record<string,unknown>;
 const bytes=encodeMotanJson(initial).length;
 assert.throws(()=>new MotanStatusTracker(initial,async()=>null,bytes-1),/size limit/);
 const tracker=new MotanStatusTracker(initial,async()=>null,bytes);
 assert.equal(encodeMotanJson((await tracker.sample(0)).status).length,bytes);
 const updated=parseTypedMotanJson('{"sensor":{"f":1}}') as Record<string,unknown>;
 let sent=false;const shrinking=new MotanStatusTracker(initial,async()=>sent?null:(sent=true,{status:updated}),bytes);
 assert.equal(encodeMotanJson((await shrinking.sample(0)).status).length,bytes-2);
});

test('capture terminates on valid JSON exceeding metadata resources instead of silently dropping it',async()=>{
 for(const kind of ['count','depth'] as const){
  const writes:Uint8Array[]=[],output:string[]=[],capture=new MotanCapture({log:{async addRecords(records){writes.push(...records);},async flush(){return 0;}},index:{async addRecords(records){writes.push(...records);}}},async()=>{},[],text=>output.push(text));
  await capture.start();const values=kind==='count'?'['+Array(65537).fill('1.0').join(',')+']':'['.repeat(10000)+'0'+']'.repeat(10000);
  const raw=Buffer.from('{"q":"status","params":{"eventtime":0,"status":{"sensor":{"values":'+values+'}}}}');
  assert.doesNotThrow(()=>JSON.parse(raw.toString()));
  await assert.rejects(capture.accept([raw]),kind==='count'?MotanNumberMetadataError:RangeError);
  assert.equal(capture.status.ended,true);assert.equal(writes.length,0);assert.deepEqual(output,[]);
  await assert.rejects(capture.accept([]),/Invalid Motan capture state/);
 }
 const output:string[]=[],capture=new MotanCapture({log:{async addRecords(){},async flush(){return 0;}},index:{async addRecords(){}}},async()=>{},[],text=>output.push(text));
 await capture.start();await capture.accept([Buffer.from('{')]);assert.equal(capture.status.ended,false);assert.match(output.join(''),/Unable to parse/);
});
