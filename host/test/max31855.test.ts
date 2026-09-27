import test from 'node:test';
import assert from 'node:assert/strict';
import {max31855Temperature,max31855Range} from '../src/thermal/max31855.ts';
test('all signed thermocouple codes decode independently of cold-junction sign',()=>{
 for(let code=0;code<16384;code++)for(const cold of [0,0x7ff,0x800,0xfff])assert.equal(max31855Temperature(code*262144+cold*16),(code<8192?code:code-16384)/4);
 for(const [raw,value] of [[0x01900000,25],[0xfffc0000,-.25],[0xfff00000,-1],[0xf0600000,-250]])assert.equal(max31855Temperature(raw),value);
});
test('chip faults, reserved bits and malformed wire values are rejected',()=>{
 for(const bit of [0,1,2,3,16,17])assert.throws(()=>max31855Temperature(100*262144+2**bit));
 for(const raw of [-1,2**32,.5,NaN,Infinity])assert.throws(()=>max31855Temperature(raw));
});
test('signed range bounds include cold-junction fields and round limits inward',()=>{
 for(const [low,high] of [[-273.15,-.1],[-10,10],[0,300],[.1,.9],[1800,2047.75]]){
  const range=max31855Range(low,high);assert.equal(range.signed,Math.ceil(low*4)<0);
  for(let code=-1092;code<=8191;code++)for(const cold of [0,0xfff]){const raw=((code&0x3fff)*262144+cold*16)>>>0;const accepted=(raw|0)>=(range.minimum|0)&&(raw|0)<=(range.maximum|0);assert.equal(accepted,code/4>=low&&code/4<=high);}
 }
 for(const [a,b] of [[NaN,300],[-274,300],[10,10],[.01,.02],[300,Infinity],[2048,3000]])assert.throws(()=>max31855Range(a,b));
});
