import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {encodeInteger,decodeInteger,encodeFrame,checkFrame,FrameDecoder} from '../src/protocol/codec.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
if(Number(process.versions.node.split('.')[0])!==26) throw new Error('Node.js 26 required');
let seed=0x12345678;
function random():number {seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;}
const values=[-2147483648,-67108865,-67108864,-524289,-524288,-4097,-4096,-33,-32,-1,0,95,96,12287,12288,1572863,1572864,201326591,201326592,2147483647,2147483648,4294967295];
for(let i=0;i<10000;i++) {const value=random();values.push(i%2 ? value : value|0);}
const format='queue_step oid=%c interval=%u count=%hu add=%hi';
const dictionary={commands:{[format]:-32},responses:{},config:{},enumerations:{}};
const commands=Array.from({length:10000},()=>({oid:random()%256,interval:random(),count:random()%65536,add:(random()%65536)-32768}));
const python=String.raw`
import sys,json,time
sys.path.insert(0,sys.argv[1]);import msgproto as m
with open(sys.argv[2]) as f: data=json.load(f)
p=m.MessageParser();p.process_identify(json.dumps(data['dictionary']).encode(),decompress=False)
encoded=[]
for value in data['values']:
    out=[];m.PT_int32().encode(out,value);encoded.append(out)
frames=[]
for i,c in enumerate(data['commands']):
    payload=p.lookup_command(data['format']).encode_by_name(**c)
    frame=[len(payload)+5,0x10|(i&15)]+payload
    frame+=m.crc16_ccitt(frame)+[0x7e];frames.append(frame)
def batch():
    checksum=0
    for i,c in enumerate(data['commands']):
        payload=p.lookup_command(data['format']).encode_by_name(**c)
        frame=[len(payload)+5,0x10|(i&15)]+payload
        frame+=m.crc16_ccitt(frame)+[0x7e]
        assert p.check_packet(frame)==len(frame)
        checksum+=p.parse(frame)['interval']
    return checksum
for _ in range(3): batch()
times=[]
for _ in range(11):
    start=time.perf_counter();checksum=batch();times.append((time.perf_counter()-start)*1000)
print(json.dumps({'encoded':encoded,'frames':frames,'times':sorted(times),'checksum':checksum,'python':sys.version}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-protocol-'));
let oracle;
try {
  const path=join(dir,'input.json');writeFileSync(path,JSON.stringify({dictionary,format,values,commands}));
  const run=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy',import.meta.url)),path],{encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
  if(run.status!==0) throw new Error(run.stderr||String(run.error));
  oracle=JSON.parse(run.stdout);
} finally {rmSync(dir,{recursive:true,force:true});}
values.forEach((value,i)=>{
  assert.deepEqual(encodeInteger(value),oracle.encoded[i]);
  assert.equal(decodeInteger(Uint8Array.from(oracle.encoded[i]),0,true).value,value);
});
const d=new MessageDictionary();d.identify(new TextEncoder().encode(JSON.stringify(dictionary)),false);
commands.forEach((c,i)=>{
  const frame=encodeFrame(i,d.encode('queue_step',c));
  assert.deepEqual([...frame],oracle.frames[i]);
  assert.deepEqual({...d.parseFrame(frame)[0].parameters},c);
});
function batch():number {
  let checksum=0;
  for(let i=0;i<commands.length;i++) {
    const frame=encodeFrame(i,d.encode('queue_step',commands[i]));
    assert.equal(checkFrame(frame),frame.length);
    checksum+=d.parseFrame(frame)[0].parameters.interval as number;
  }
  return checksum;
}
for(let i=0;i<3;i++) batch();
const times=[];
for(let i=0;i<11;i++) {const start=performance.now();assert.equal(batch(),oracle.checksum);times.push(performance.now()-start);}
times.sort((a,b)=>a-b);
const stream=Uint8Array.from(oracle.frames.flat()),decoder=new FrameDecoder(),start=performance.now();
let frames=0;
for(let offset=0;offset<stream.length;offset+=127) frames+=decoder.push(stream.subarray(offset,offset+127)).length;
const streamMs=performance.now()-start;
assert.equal(frames,commands.length);
console.log(JSON.stringify({node:process.version,python:oracle.python,cpu:cpus()[0].model,integers:values.length,frames:commands.length,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[5],pythonP95Ms:oracle.times[10],speedup:oracle.times[5]/times[5],streamFramesPerSecond:frames/streamMs*1000,checksum:oracle.checksum},null,2));
assert.ok(times[5]<=oracle.times[5],'Protocol pipeline regressed against Python');
