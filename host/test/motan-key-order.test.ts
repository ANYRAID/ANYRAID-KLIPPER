import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {parseTypedMotanJson,cloneMotanJson,mergeMotanObjects,assignMotanObject,copyMotanStatusRoot,motanObjectKeys} from '../src/motan/number-types.ts';
import {encodeMotanJson} from '../src/motan/capture.ts';
import {MotanStatusTracker} from '../src/motan/dispatch.ts';
const parse=(text:string)=>parseTypedMotanJson(text) as Record<string,unknown>;
const encode=(value:unknown)=>encodeMotanJson(value).toString();
const shapes=(texts:string[])=>JSON.parse(execFileSync('python3',['-c',`import json,sys,struct
def shape(v):
 if type(v)==dict:return ['dict',[[k,shape(x)] for k,x in v.items()]]
 if type(v)==list:return ['list',[shape(x) for x in v]]
 if type(v)==float:return ['float',struct.pack('>d',v).hex()]
 if type(v)==int:return ['int',str(v)]
 return v
print(json.dumps([shape(json.loads(s)) for s in json.load(sys.stdin)]))`],{input:JSON.stringify(texts),encoding:'utf8',timeout:10000})) as unknown[];

test('Python object order, duplicate shapes, escapes and numeric types survive clone and JSON encoding',()=>{
 const cases=[
  '{"2":"two","1":"one","0":"zero","a":"last"}',
  '{"name":{"2":1,"1":1.0},"array":[{"3":-0.0,"0":9007199254740993}],"__proto__":{"2":null,"1":true}}',
  '{"\\u0032":"two","1":"one","4294967295":"non-index","01":"leading-zero"}',
  '{"2":{"old":{}},"1":false,"2":[{"4":"x","3":"y"}],"1":{"9":"nine","8":"eight"}}',
  '{"2":[{"5":true}],"1":null,"2":"last"}',
  '{"s":"escaped \\\"2\\\" bracket } and \\\\ slash","3":[],"1":{}}',
 ];
 for(const source of cases){
  const value=parse(source),owned:Record<string,unknown>=Object.create(null);assignMotanObject(owned,value);
  const copies=[value,cloneMotanJson(value),mergeMotanObjects({},value),owned];
  Object.defineProperty(value,'hidden',{value:1});Object.defineProperty(value,Symbol('hidden'),{value:2});Object.freeze(value);
  const result=shapes([source,...copies.map(encode)]);for(const actual of result.slice(1))assert.deepEqual(actual,result[0]);
  assert.equal(encode(cloneMotanJson(parse(encode(value)))),encode(value));
 }
 assert.equal(({} as Record<string,unknown>).old,undefined);
});

test('immutable and mutable status merges keep overwrite positions and append new keys in source order',async()=>{
 const initial=parse('{"sensor":{"name":"first","2":1,"1":1.0},"2":{"x":0},"1":{"x":1}}');
 const update=parse('{"0":{"v":true},"sensor":{"1":2,"4":4.0,"3":3},"2":{"x":2}}');
 const root=copyMotanStatusRoot(initial,update);
 for(const [key,value]of Object.entries(update))root[key]=mergeMotanObjects((initial[key]??{}) as Record<string,unknown>,value as Record<string,unknown>);
 assert.deepEqual(motanObjectKeys(root),['sensor','2','1','0']);
 assert.deepEqual(motanObjectKeys(root.sensor as object),['name','2','1','4','3']);
 const owned=cloneMotanJson(initial.sensor as Record<string,unknown>);assignMotanObject(owned,update.sensor as Record<string,unknown>);
 assert.equal(encode(owned),encode(root.sensor));assert.equal(encode(initial.sensor),'{"name":"first","2":1,"1":1.0}');
 let sent=false;const tracker=new MotanStatusTracker(initial,async()=>sent?null:(sent=true,{status:update}));
 const snapshot=(await tracker.sample(0)).status;
 assert.equal(encode(snapshot),encode(root));assert.equal(encode(cloneMotanJson(snapshot)),encode(root));
});

test('order metadata fails on stale keys and bounded scan resources; cycles retain JSON rejection',()=>{
 for(const mutate of [(v:Record<string,unknown>)=>{v.extra=true;},(v:Record<string,unknown>)=>{delete v['1'];}]){
  const v=parse('{"2":"two","1":"one"}');mutate(v);
  assert.throws(()=>encode(v),/Mutated Motan key order/);assert.throws(()=>cloneMotanJson(v),/Mutated Motan key order/);
 }
 const cycle=parse('{"2":null,"1":true}');cycle['2']=cycle;assert.throws(()=>encode(cycle),/circular/i);
 assert.throws(()=>parse('{"2":'+ '['.repeat(65)+'null'+']'.repeat(65)+'}'),/nesting limit/);
 assert.throws(()=>parse('{"2":['+Array(65537).fill('null').join(',')+']}'),/metadata limit/);
});
