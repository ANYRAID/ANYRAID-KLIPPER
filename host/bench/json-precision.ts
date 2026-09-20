import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {parseRequestJson,JsonNumberError} from '../src/moonraker/json.ts';
const fixtures={motion:'{"jsonrpc":"2.0","method":"printer.move","params":{"x":120.125,"y":8.5,"velocity":100,"clock":"12345"},"id":1}',exactString:'{"jsonrpc":"2.0","method":"printer.move","params":{"clock":"9007199254740993","position":[1.25,2.5,0.1]},"id":2}',safeBoundary:'{"jsonrpc":"2.0","method":"echo","params":{"counter":9007199254740991},"id":3}'};
const result:Record<string,unknown>={};let checksum=0;
for(const [name,source] of Object.entries(fixtures)){
 assert.deepEqual(parseRequestJson(source),JSON.parse(source));const native:number[]=[],checked:number[]=[];
 for(let run=0;run<14;run++)for(const mode of run%2?[1,0]:[0,1]){const start=performance.now();for(let i=0;i<10000;i++)checksum+=((mode?parseRequestJson(source):JSON.parse(source)) as {id:number}).id;const ms=performance.now()-start;if(run>=3)(mode?checked:native).push(ms);}
 native.sort((a,b)=>a-b);checked.sort((a,b)=>a-b);result[name]={nativeMedianMs:native[5],nativeP95Ms:native[10],checkedMedianMs:checked[5],checkedP95Ms:checked[10]};
}
assert.equal(checksum,1680000);const unsafe='{"clock":9007199254740993}';assert.equal(JSON.parse(unsafe).clock,9007199254740992);assert.throws(()=>parseRequestJson(unsafe),JsonNumberError);
console.log(JSON.stringify({node:process.version,operations:10000,samples:11,result,scope:'Conditional source-aware parsing versus unprotected native JSON.parse. Ordinary coordinates, exact integer strings and safe integer boundary reported separately; native unsafe parsing is not a correctness baseline.'},null,2));
