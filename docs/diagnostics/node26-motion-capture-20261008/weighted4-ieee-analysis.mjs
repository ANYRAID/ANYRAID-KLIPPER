import {readFileSync,writeFileSync} from 'node:fs';
import {deserialize} from 'node:v8';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const sha=b=>createHash('sha256').update(b).digest('hex');
const compressed=readFileSync(process.argv[2]),raw=gunzipSync(compressed),c=deserialize(raw);
const abs=n=>n<0n?-n:n, length=n=>n.toString(2).length;
function decode(bits){
 const exponent=Number(bits>>52n&2047n),fraction=bits&((1n<<52n)-1n);
 assert(exponent!==2047);
 return {m:(bits>>63n?-1n:1n)*(fraction+(exponent?1n<<52n:0n)),e:exponent?exponent-1075:-1074,bits};
}
const fromSaved=value=>{const b=Buffer.alloc(8);b.writeDoubleLE(value);return decode(b.readBigUInt64LE());};
const zero=decode(0n), hex=v=>'0x'+v.bits.toString(16).padStart(16,'0');
// Correct round-to-nearest, ties-to-even using integer quotient/remainder.
// This bounded scalar analysis rejects subnormal/overflow results rather than
// pretending to implement IEEE cases that the selected saved samples do not use.
function round(num,den=1n,exponent=0){
 assert(den>0n);if(num===0n)return zero;
 const sign=num<0n?1n:0n;num=abs(num);
 let power=length(num)-length(den);
 if(power>=0?num<(den<<BigInt(power)):(num<<BigInt(-power))<den)power--;
 power+=exponent;assert(power>=-1022&&power<=1023);
 const shift=exponent+52-power;
 const numerator=shift>=0?num<<BigInt(shift):num;
 const denominator=shift>=0?den:den<<BigInt(-shift);
 let mantissa=numerator/denominator;const remainder=numerator%denominator;
 if(2n*remainder>denominator||(2n*remainder===denominator&&(mantissa&1n)))mantissa++;
 if(mantissa===1n<<53n){mantissa>>=1n;power++;}
 assert(power<=1023&&mantissa>=1n<<52n&&mantissa<1n<<53n);
 return decode((sign<<63n)|(BigInt(power+1023)<<52n)|(mantissa-(1n<<52n)));
}
function add(a,b){if(!a.m)return b;if(!b.m)return a;const e=Math.min(a.e,b.e);return round((a.m<<BigInt(a.e-e))+(b.m<<BigInt(b.e-e)),1n,e);}
const negate=a=>({...a,m:-a.m,bits:a.bits^(1n<<63n)});
const sub=(a,b)=>add(a,negate(b));
const mul=(a,b)=>round(a.m*b.m,1n,a.e+b.e);
const magnitudeAtLeast=(a,b)=>{const e=Math.min(a.e,b.e);return (abs(a.m)<<BigInt(a.e-e))>=(abs(b.m)<<BigInt(b.e-e));};
const controls=[];
for(const [name,num,den,e,bits] of [
 ['one',1n,1n,0,0x3ff0000000000000n],
 ['third',1n,3n,0,0x3fd5555555555555n],
 ['negative third',-1n,3n,0,0xbfd5555555555555n],
 ['even tie down',(1n<<53n)+1n,1n,-53,0x3ff0000000000000n],
 ['odd tie up',(1n<<53n)+3n,1n,-53,0x3ff0000000000002n],
 ['carry tie',(1n<<54n)-1n,1n,-53,0x4000000000000000n],
 ]){assert.equal(round(num,den,e).bits,bits,name);controls.push(name);}
assert.equal(add(round(1n),round(1n,1n,-53)).bits,0x3ff0000000000000n);controls.push('rounded addition');
assert.equal(sub(round(1n),round(1n)).bits,0n);controls.push('cancellation');
assert.equal(mul(round(3n),round(1n,1n,-1)).bits,0x3ff8000000000000n);controls.push('rounded multiplication');
const n=83,weight=round(15n,16n*BigInt(n)**5n),computed=new Map();
function point(index){
 let high=zero,low=zero;
 for(let j=index-n;j<index+n;j++){
  const coefficient=round(BigInt(n*n-(j-index)**2)**2n);
  const value=mul(fromSaved(c.stages.nominal[j]),coefficient),next=add(high,value);
  low=add(low,magnitudeAtLeast(high,value)?add(sub(high,next),value):add(sub(value,next),high));high=next;
 }
 const result=mul(add(high,low),weight),actual=fromSaved(c.stages.updated[index]);computed.set(index,result);
 const e=Math.min(result.e,actual.e),difference=(actual.m<<BigInt(actual.e-e))-(result.m<<BigInt(result.e-e));
 return {index,actualBits:hex(actual),emulatedBits:hex(result),equal:actual.bits===result.bits,exactResidual:{integer:difference.toString(),binaryExponent:e},approximateResidual:Number(difference)*2**e};
}
const result={schema:1,node:process.version,rawSha256:sha(raw),compressedSha256:sha(compressed),analyzerSha256:sha(readFileSync(new URL(import.meta.url))),sourceSha256:sha(readFileSync('host/src/diagnostics/motion-filters.ts')),controls,weightBits:hex(weight),points:[4398,4399,4400,7855,7856,7857,8661,8662,8663].map(point),method:'Integer emulation of each binary64 multiply, add and subtract in the saved weighted4 scalar operation, including Neumaier branches and rounded weight; round-to-nearest ties-to-even, n=83. No host floating arithmetic in emulated numeric operations.',scope:'Frozen saved nominal inputs only. No original motion/filter import or live regeneration, no failed test rerun. A differing stored result does not distinguish transient arithmetic faults, changed input before capture, serialization/memory faults or other runtime/compiler/hardware causes. G3 remains unresolved.'};
result.velocity=[4399,4400,7856,7857,8662,8663].map(index=>{
 const emulated=mul(sub(computed.get(index),computed.get(index-1)),round(10000n));
 const reference=fromSaved(c.reference.panels[0].curves[0].values[index]);
 return {index,emulatedBits:hex(emulated),referenceBits:hex(reference),equalReference:emulated.bits===reference.bits,actualBits:hex(fromSaved(c.stages.velocity[0][index]))};
});
writeFileSync(process.argv[3],JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({controls:controls.length,weightBits:result.weightBits,points:result.points,velocity:result.velocity}));
