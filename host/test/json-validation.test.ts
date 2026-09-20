import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateJson} from '../src/moonraker/rpc.ts';
test('JSON validation preserves scalar, prototype and shared-reference rules',()=>{
 for(const value of [null,true,false,'',1,-0,1e20,[],{},Object.assign(Object.create(null),{x:1})])assert.doesNotThrow(()=>validateJson(value));
 for(const value of [undefined,NaN,Infinity,-Infinity,1n,()=>{},Symbol('x'),new Date(),new Map(),new Set(),new Number(1),Object.create({x:1})])assert.throws(()=>validateJson(value));
 const child={x:[1,2]};assert.doesNotThrow(()=>validateJson({left:child,right:child}));const loop:any={};loop.self=loop;assert.throws(()=>validateJson(loop),/Cyclic/);const array:any[]=[];array.push(array);assert.throws(()=>validateJson(array),/Cyclic/);
});
test('depth and node budgets include root and reject before recursive stack growth',()=>{
 let value:unknown=null;for(let i=0;i<64;i++)value={child:value};assert.doesNotThrow(()=>validateJson(value));assert.throws(()=>validateJson({child:value}),/structure limit/);
 let deep:unknown=null;for(let i=0;i<10000;i++)deep=[deep];assert.throws(()=>validateJson(deep),/structure limit/);
 assert.doesNotThrow(()=>validateJson(Array(99999).fill(null)));assert.throws(()=>validateJson(Array(100000).fill(null)),/structure limit/);
 const shared={value:1};assert.doesNotThrow(()=>validateJson(Array(49999).fill(shared)));assert.throws(()=>validateJson(Array(50000).fill(shared)),/structure limit/);
});
test('own special keys, sparse arrays and extra enumerable array properties remain validated',()=>{
 const own=JSON.parse('{"__proto__":{"ok":true},"constructor":{"n":1}}');assert.doesNotThrow(()=>validateJson(own));assert.equal(({} as any).ok,undefined);
 const sparse=Array(5);sparse[4]=1;assert.doesNotThrow(()=>validateJson(sparse));Object.defineProperty(sparse,'extra',{enumerable:true,value:NaN});assert.throws(()=>validateJson(sparse),/Non-JSON/);
 const hidden={};Object.defineProperty(hidden,'bad',{enumerable:false,value:Infinity});assert.doesNotThrow(()=>validateJson(hidden));
});
