import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseExactJson,stringifyExactJson,type ExactJson} from '../src/moonraker/json-exact.ts';
import {parseRequestJson} from '../src/moonraker/json.ts';
import {validateJson} from '../src/moonraker/rpc.ts';
const reference=JSON.parse(await readFile(new URL('../contracts/moonraker-secrets-reference.json',import.meta.url),'utf8')) as {cases:{name:string;text:string;type:string;expected:unknown}[]};
function normalized(value:ExactJson):unknown{if(typeof value==='bigint')return {$exactInteger:value.toString()};if(typeof value==='number'&&Object.is(value,-0))return {$negativeZero:true};if(Array.isArray(value))return value.map(normalized);if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalized(item)]));return value;}
for(const row of reference.cases.filter(row=>row.type==='json'))test('component exact JSON matches frozen upstream parsing: '+row.name,()=>assert.deepEqual(normalized(parseExactJson(row.text)),row.expected));
test('exact component integers include scalar/array values beyond i128, safe boundaries and duplicate/prototype keys',()=>{
 for(const integer of [-(2n**256n),-(2n**127n)-1n,-9007199254740993n,-9007199254740991n,0n,9007199254740991n,9007199254740993n,2n**128n,10n**1023n]){
  const token=integer.toString(),value=parseExactJson(token),expected=integer>=BigInt(Number.MIN_SAFE_INTEGER)&&integer<=BigInt(Number.MAX_SAFE_INTEGER)?Number(integer):integer;assert.equal(value,expected);assert.deepEqual(parseExactJson('['+token+']'),[expected]);
 }
 const value=parseExactJson('{"value":1,"value":9007199254740993,"__proto__":{"literal":18446744073709551617}}') as Record<string,ExactJson>;assert.equal(value.value,9007199254740993n);assert(Object.hasOwn(value,'__proto__'));assert.equal((value.__proto__ as Record<string,ExactJson>).literal,18446744073709551617n);assert.equal(Object.getPrototypeOf(value),Object.prototype);
});
test('integer tokens, decimal/exponent tokens and negative zero retain distinct numeric semantics',()=>{
 assert(Object.is(parseExactJson('-0'),0));for(const token of ['-0.0','-0e100'])assert(Object.is(parseExactJson(token),-0));
 assert.equal(parseExactJson('9007199254740993'),9007199254740993n);assert.equal(parseExactJson('9007199254740993.0'),9007199254740992);assert.equal(parseExactJson('9.007199254740993e15'),9007199254740992);assert.equal(parseExactJson('1e100'),1e100);
 assert.equal(parseExactJson('"9007199254740993000000000"'),'9007199254740993000000000');assert.equal(parseExactJson('"a \\\" 9007199254740993000000000"'),'a " 9007199254740993000000000');
 for(const text of ['1e400','-1e400'])assert.throws(()=>parseExactJson(text),/finite/);
});
test('exact JSON integer capacity is explicit and ordinary small-capacity integers cannot bypass it',()=>{
 assert.equal(parseExactJson('9'.repeat(4096)),BigInt('9'.repeat(4096)));assert.throws(()=>parseExactJson('9'.repeat(4097)),/capacity/);assert.equal(parseExactJson('9'.repeat(4097),{integerDigits:4097}),BigInt('9'.repeat(4097)));
 for(const text of ['12345','-12345'])assert.throws(()=>parseExactJson(text,{integerDigits:4}),/capacity/);assert.equal(parseExactJson('-1234',{integerDigits:4}),-1234);
 for(const integerDigits of [0,-1,1.5,NaN,Infinity])assert.throws(()=>parseExactJson('1',{integerDigits}),/capacity/);
});
test('exact component serializer roundtrips nested arbitrary integers, binary64 values and negative zero',()=>{
 const exact=2n**200n+123n,source={root:[exact,-exact,-0,1e20,1.23456789012345e100,true,null,' 9007199254740993123 '],duplicate:exact},wire=stringifyExactJson(source);
 assert(wire.includes(exact.toString()));assert(!wire.includes('"'+exact.toString()+'"'));assert(wire.includes('-0.0'));assert(wire.includes('1e+20'));assert.deepEqual(parseExactJson(wire),source);
 const shared={value:exact};assert.deepEqual(parseExactJson(stringifyExactJson({left:shared,right:shared})),{left:shared,right:shared});
 for(const value of [NaN,Infinity,-Infinity])assert.throws(()=>stringifyExactJson(value),/finite/);
 const cycle:any={};cycle.self=cycle;assert.throws(()=>stringifyExactJson(cycle),/Cyclic/);assert.throws(()=>stringifyExactJson(new Date() as any),/Non-JSON/);assert.throws(()=>stringifyExactJson({value:()=>1} as any),/Non-JSON/);assert.throws(()=>stringifyExactJson(10n**4096n),/capacity/);
});
test('component BigInts gain no permission to enter existing public RPC JSON or motion-facing parsing',()=>{
 const value=parseExactJson('{"clock":18446744073709551617}');assert.equal((value as Record<string,ExactJson>).clock,18446744073709551617n);assert.throws(()=>validateJson(value),/Non-JSON/);assert.throws(()=>parseRequestJson('{"clock":18446744073709551617}'),/safe range/);
});
test('deterministic mixed numeric trees preserve exact arithmetic and escaped number-like strings',()=>{
 let state=42;const random=()=>{state=(1664525*state+1013904223)>>>0;return state;};
 for(let i=0;i<1000;i++){
  const integer=(BigInt(random())<<160n)+BigInt(random()),signed=i%2?-integer:integer,exponent=Number(random()%601)-300,float=Number('1.23456789012345e'+exponent),literal='quoted " \\ [ '+signed.toString()+' 1e400 -0.0 ]',source='{"integer":'+signed+',"float":1.23456789012345e'+exponent+',"literal":'+JSON.stringify(literal)+',"array":['+signed+',-0,-0.0]}';
  const value=parseExactJson(source) as {integer:bigint;float:number;literal:string;array:ExactJson[]};assert.equal(value.integer,signed);assert.equal(value.integer-signed,0n);assert.equal(value.float,float);assert.equal(value.literal,literal);assert(Object.is(value.array[1],0));assert(Object.is(value.array[2],-0));assert.deepEqual(parseExactJson(stringifyExactJson(value)),value);
 }
});
