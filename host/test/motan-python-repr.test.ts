import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {motanPythonRepr,motanFloatRepr} from '../src/motan/python-repr.ts';
import {parseTypedMotanJson} from '../src/motan/number-types.ts';
import {motanScalarBytes,motanStructuredCell} from '../src/motan/table.ts';
const python=(script:string,input:unknown)=>JSON.parse(execFileSync('python3',['-c',script],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:32*1024**2,timeout:30000}));

test('structured repr matches Python integer/float/null/bool/string and ordered nested JSON values',()=>{
 const source=[
  '{"2":[1,1.0,-0,-0.0,1e16,1e-4,1e-5,true,false,null],"1":{"wide":9007199254740993,"huge":'+(1n<<2000n)+'}}',
  '[{},[],"single\'quote","double\\\"quote","both\'\\\"quote","\\\\","line\\n\\t\\r\\u0000","雪😀"]',
  '{"__proto__":true,"\\u0032":"two","1":"one","2":[null,"replacement"]}',
 ];
 const reference=python('import json,sys\nprint(json.dumps([repr(json.loads(s)) for s in json.load(sys.stdin)]))',source);
 assert.deepEqual(source.map(s=>motanPythonRepr(parseTypedMotanJson(s))),reference);
});

test('Python float notation and shortest digits match 20000 finite Float64 bit patterns',()=>{
 const values=[0,-0,1,-1,1e16,1e15,1e-4,1e-5,Number.MIN_VALUE,Number.MAX_VALUE,1000000000000000100],buffer=Buffer.alloc(8);let state=19;
 const random=()=>state=(Math.imul(state,1664525)+1013904223)>>>0;
 while(values.length<20000){buffer.writeUInt32BE(random(),0);buffer.writeUInt32BE(random(),4);const value=buffer.readDoubleBE();if(Number.isFinite(value))values.push(value);}
 const hex=values.map(v=>{buffer.writeDoubleBE(v);return buffer.toString('hex');});
 const expected=python("import json,sys,struct\nprint(json.dumps([repr(struct.unpack('>d',bytes.fromhex(s))[0]) for s in json.load(sys.stdin)]))",hex);
 assert.deepEqual(values.map(motanFloatRepr),expected);
});

test('Unicode 15 printability and quotes match Python across all codepoints in bounded batches',()=>{
 const strings:string[]=[];
 for(let base=0;base<=0x10ffff;base+=512){let value='';for(let i=base;i<Math.min(base+512,0x110000);i++)value+=String.fromCodePoint(i);strings.push(value);}
 const expected=python('import json,sys,unicodedata\nassert unicodedata.unidata_version=="15.0.0"\nprint(json.dumps([repr(s) for s in json.load(sys.stdin)]))',strings);
 assert.deepEqual(strings.map(s=>motanPythonRepr(s)),expected);
});

test('repr bounds output, visits, depth and integers, rejects ambiguous numbers, accessors and cycles',()=>{
 const value=parseTypedMotanJson('{"2":[1,1.0],"1":"雪"}'),text=motanPythonRepr(value),size=Buffer.byteLength(text);
 assert.equal(motanPythonRepr(value,size),text);assert.throws(()=>motanPythonRepr(value,size-1),/output limit/);
 assert.throws(()=>motanPythonRepr({v:1}),/typed JSON numbers/);
 let calls=0;const getter=Object.defineProperty({},'v',{enumerable:true,get(){calls++;return 1;}});assert.throws(()=>motanPythonRepr(getter),/data properties/);assert.equal(calls,0);
 assert.throws(()=>motanPythonRepr(new Date()),/plain JSON/);
 const cycle:unknown[]=[];cycle.push(cycle);assert.throws(()=>motanPythonRepr(cycle),/cycles/);
 let deep:unknown=null;for(let i=0;i<66;i++)deep=[deep];assert.throws(()=>motanPythonRepr(deep),/depth/);
 assert.throws(()=>motanPythonRepr(Array(65537).fill(null)),/node limit/);
 assert.throws(()=>motanPythonRepr(10n**4300n),/digit limit/);
 assert.throws(()=>motanFloatRepr(Infinity),/finite/);
 const cell=motanStructuredCell(text);assert.ok(Object.isFrozen(cell));assert.equal(motanScalarBytes(cell),32+text.length*2+size);
 assert.equal(motanScalarBytes(structuredClone(cell)),motanScalarBytes(cell));
 assert.throws(()=>motanScalarBytes({kind:'python-repr',text:'v',extra:true}),/finite scalar/);
});
