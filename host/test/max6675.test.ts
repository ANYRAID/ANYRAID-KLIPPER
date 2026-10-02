import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {max6675Temperature,max6675Range} from '../src/thermal/max6675.ts';
test('all 4096 MAX6675 codes match unsigned quarter-degree datasheet format, including tri-state D0',()=>{
 for(let code=0;code<4096;code++){assert.equal(max6675Temperature(code*8),code/4);assert.equal(max6675Temperature(code*8+1),code/4);}
 for(const raw of [-1,65536,NaN,Infinity,.5,2,4,6,0x8000,0xffff])assert.throws(()=>max6675Temperature(raw));
});
test('firmware boundaries admit only configured temperatures and include D0 at exact upper limit',()=>{
 for(const [min,max] of [[0,100],[-273.15,99999999.9],[20.01,20.99],[1000,1023.75]]){
  const range=max6675Range(min,max);for(let code=0;code<4096;code++)for(const bit of [0,1])assert.equal(code*8+bit>=range.minimum&&code*8+bit<=range.maximum,code/4>=min&&code/4<=max);
 }
 for(const [min,max] of [[20.01,20.1],[100,90],[-274,100],[1024,2000],[-10,-1],[NaN,1]])assert.throws(()=>max6675Range(min,max));
});
test('all valid raw frames match the frozen original Python binary64 reference',()=>{
 const reference=JSON.parse(readFileSync(new URL('../contracts/max6675-reference.json',import.meta.url),'utf8')),values=Buffer.alloc(reference.cases*8);let offset=0;
 for(let code=0;code<4096;code++)for(const bit of [0,1]){values.writeDoubleBE(max6675Temperature(code*8+bit),offset);offset+=8;}
 assert.equal(createHash('sha256').update(values).digest('hex'),reference.expectedSha256);
});
