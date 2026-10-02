import test from 'node:test';
import assert from 'node:assert/strict';
import {max31856Temperature,max31856Range} from '../src/thermal/max31856.ts';
test('all 19-bit signed codes decode independently of all unspecified low bits',()=>{
 for(let code=0;code<524288;code++){
  const expected=(code<262144?code:code-524288)/128;
  for(let low=0;low<32;low++)assert.equal(max31856Temperature(code*32+low),expected);
 }
 for(const [raw,temp] of [[0x019000,25],[0xffffe0,-1/128],[0xfff000,-1],[0x800000,-2048],[0x7fffe0,2047.9921875]])assert.equal(max31856Temperature(raw),temp);
});
test('malformed wire values are rejected without coercion',()=>{
 for(const value of [-1,0x1000000,.5,NaN,Infinity,-Infinity,'0',null])assert.throws(()=>max31856Temperature(value as number));
});
test('24-bit signed limits quantize inward and include unspecified low bits',()=>{
 const signed=(raw:number)=>raw>=0x800000?raw-0x1000000:raw;
 for(const [minimum,maximum] of [[-273.15,-.001],[-100,300],[0,300],[.001,.02],[2000,99999999]]){
  const range=max31856Range(minimum,maximum);
  for(let code=-262144;code<=262143;code++)for(const low of [0,31]){
   const raw=((code&0x7ffff)*32)+low;
   const accepted=signed(raw)>=signed(range.minimum)&&signed(raw)<=signed(range.maximum);
   assert.equal(accepted,code/128>=minimum&&code/128<=maximum);
  }
 }
 for(const [a,b] of [[NaN,300],[-274,300],[10,10],[.001,.002],[300,Infinity],[2048,3000],[-273.15,-273.149]])assert.throws(()=>max31856Range(a,b));
});
