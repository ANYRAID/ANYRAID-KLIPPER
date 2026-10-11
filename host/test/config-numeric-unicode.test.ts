import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parsePythonFloat,parseConfigurationFloat,parseConfigurationInteger,ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource,ConfigurationError} from '../src/moonraker/config-source.ts';
import {templateFloat} from '../src/moonraker/template-numbers.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/config-numeric-unicode-ranges.json',import.meta.url),'utf8')) as {schema:number;zeroCodePoints:number[]};
test('pinned BMP and supplementary decimal scripts retain digits, mixed syntax and negative zero',()=>{
 assert.equal(reference.schema,1);assert.equal(reference.zeroCodePoints.length,68);
 for(const zero of reference.zeroCodePoints){
  const d=(n:number)=>String.fromCodePoint(zero+n);
  for(let n=0;n<10;n++){assert.equal(parsePythonFloat(d(n)),n);assert.equal(parseConfigurationInteger(d(n)),n);}
  for(const token of [`-${d(1)}_${d(2)}.${d(5)}e-${d(1)}`,`-${d(1)}_2.５e-${d(1)}`]){
   assert.equal(parsePythonFloat(token),-1.25);assert.equal(parseConfigurationFloat(token),-1.25);
  }
  assert(Object.is(parsePythonFloat('-'+d(0)),-0));assert(Object.is(parseConfigurationFloat('-'+d(0)),-0));assert(!Object.is(parseConfigurationInteger('-'+d(0)),-0));
  for(const token of [`${d(1)}__${d(2)}`,`${d(1)}_.${d(2)}`,`${d(1)}._${d(2)}`,`${d(1)}e_${d(2)}`,`${d(1)}e+_${d(2)}`,`_${d(1)}`,`${d(1)}_`]){
   assert.throws(()=>parsePythonFloat(token),ConfigurationError);assert.equal(templateFloat(token,'fallback'),'fallback');
  }
  const overflow=d(1)+'e999';assert.equal(parsePythonFloat(overflow),Infinity);assert.throws(()=>parseConfigurationFloat(overflow),ConfigurationError);
 }
});
test('numeric whitespace and nondecimal code points retain strict token boundaries',()=>{
 for(const cp of [9,10,11,12,13,32,0x85,0xa0,0x1680,...Array.from({length:11},(_,i)=>0x2000+i),0x2028,0x2029,0x202f,0x205f,0x3000]){
  const w=String.fromCodePoint(cp);assert.equal(parsePythonFloat(w+'١_٢.５'+w),12.5);assert.throws(()=>parsePythonFloat('١'+w+'٢'),ConfigurationError);
 }
 for(const token of ['\ud8001','1\udc00','1😀2','😀1','−١','²','Ⅻ','①','\u001c2','\u001d2','\u001e2','\u001f2','\u200b2','0x١','1.0junk']){
  assert.throws(()=>parsePythonFloat(token),ConfigurationError);assert.equal(templateFloat(token,'fallback'),'fallback');
 }
 for(const token of ['inf','-Infinity','NaN'])assert.throws(()=>parseConfigurationFloat(token),ConfigurationError);
 assert.equal(parsePythonFloat('-Infinity'),-Infinity);assert(Number.isNaN(parsePythonFloat('NaN')));
 const reader=new ConfigurationReader(new ConfigurationSource('/config/main.conf',{DEFAULT:{},server:{value:'\u2003١_٢.５\u2003'}},[]));
 assert.equal(reader.section('server').getFloat('value',{minval:12.5,maxval:12.5}),12.5);
 assert.throws(()=>reader.section('server').getFloat('value',{below:12.5}),ConfigurationError);
});
