import {readFileSync,writeFileSync} from 'node:fs';
import {deserialize} from 'node:v8';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {fromSaved,zero,hex,round,add,sub,mul,magnitudeAtLeast,controls} from './anyraid-captured-ieee-core.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const compressed=readFileSync(process.argv[2]),raw=gunzipSync(compressed),c=deserialize(raw);
assert.equal(sha(raw),'2359afd3d10045963ba3fbc3a5014ebdafdf9d9a7f11750e1bdf2526d1efdf10');
assert.equal(c.version,3);assert.equal(c.stages.nominal.length,12266);
const nominal=c.stages.nominal.map(fromSaved),capturedUpdated=c.stages.updated.map(fromSaved);
const n=83,margin=500,weight=round(15n,16n*BigInt(n)**5n);
const coefficients=Array.from({length:2*n},(_,offset)=>round(BigInt(n*n-(offset-n)**2)**2n));
const filtered=Array.from(nominal,()=>zero);
for(let i=margin;i<nominal.length-margin;i++){
 let high=zero,low=zero;
 for(let offset=0;offset<2*n;offset++){
  const value=mul(nominal[i+offset-n],coefficients[offset]),next=add(high,value);
  low=add(low,magnitudeAtLeast(high,value)?add(sub(high,next),value):add(sub(value,next),high));high=next;
 }
 filtered[i]=mul(add(high,low),weight);
}
const pi=fromSaved(Math.PI),dt=round(1n,10000n),inv=round(10000n);
assert.equal(pi.bits,0x400921fb54442d18n);assert.equal(dt.bits,fromSaved(.0001).bits);
const omega=mul(mul(round(35n),round(2n)),pi),omega2=mul(omega,omega);
const damping=mul(mul(mul(round(4n),pi),round(1n,20n)),round(35n));
function spring(input){
 let position=zero,velocity=zero;return input.map(stepper=>{
  position=add(position,mul(velocity,dt));const acceleration=mul(sub(stepper,position),omega2);
  velocity=add(velocity,mul(acceleration,dt));velocity=sub(velocity,mul(mul(velocity,damping),dt));return position;
 });
}
const derivative=input=>input.map((v,i)=>i?mul(sub(v,input[i-1]),inv):zero);
const correctedHead=spring(filtered),originalHead=spring(nominal),capturedInputHead=spring(capturedUpdated);
const correctedVelocity=derivative(filtered),correctedAcceleration=derivative(correctedVelocity);
const correctedHeadVelocity=derivative(correctedHead),correctedHeadAcceleration=derivative(correctedHeadVelocity);
const outputSha=array=>{const bytes=Buffer.alloc(array.length*8);array.forEach((v,i)=>bytes.writeBigUInt64LE(v.bits,8*i));return sha(bytes);};
function compare(stage,a,b,budget){
 assert.equal(a.length,b.length);let bitDifferences=0,aboveOriginalTolerance=0;const examples=[];
 for(let index=0;index<a.length;index++){
  if(a[index].bits===b[index].bits)continue;bitDifferences++;
  const difference=sub(a[index],b[index]);
  if(budget&&difference.m!==0n&&magnitudeAtLeast(difference,budget)&&difference.bits!==(budget.bits^(difference.m<0n?1n<<63n:0n)))aboveOriginalTolerance++;
  if(examples.length<16){const exponent=Math.min(a[index].e,b[index].e),integer=(a[index].m<<BigInt(a[index].e-exponent))-(b[index].m<<BigInt(b[index].e-exponent));examples.push({index,actualBits:hex(a[index]),expectedBits:hex(b[index]),residual:{integer:integer.toString(),binaryExponent:exponent,approximation:Number(integer)*2**exponent}});}
 }
 return {stage,length:a.length,actualSha256:outputSha(a),expectedSha256:outputSha(b),bitDifferences,...budget?{budgetBits:hex(budget),aboveOriginalTolerance}:{},examples};
}
const velocityBudget=round(1n,100000000n),accelerationBudget=round(1n,10000n),deviationBudget=round(1n,10000000000n),keep=nominal.length-1000;
const reference=(panel,curve)=>c.reference.panels[panel].curves[curve].values.map(fromSaved);
const comparisons=[
 compare('saved filtered vs emulated saved nominal',capturedUpdated,filtered),
 compare('saved nominal head vs emulated saved nominal spring',c.stages.head.map(fromSaved),originalHead),
 compare('saved new head vs emulated saved filtered spring',c.stages.newHead.map(fromSaved),capturedInputHead),
 compare('corrected filtered velocity vs fixed reference',correctedVelocity.slice(0,keep),reference(0,0),velocityBudget),
 compare('corrected filtered acceleration vs fixed reference',correctedAcceleration.slice(0,keep),reference(1,0),accelerationBudget),
 compare('corrected head velocity vs fixed reference',correctedHeadVelocity.slice(0,keep),reference(0,3),velocityBudget),
 compare('corrected head acceleration vs fixed reference',correctedHeadAcceleration.slice(0,keep),reference(1,3),accelerationBudget),
 compare('corrected head deviation vs fixed reference',correctedHead.slice(0,keep).map((v,i)=>sub(v,nominal[i])),reference(2,0),deviationBudget),
];
const result={schema:1,node:process.version,rawSha256:sha(raw),compressedSha256:sha(compressed),analyzerSha256:sha(readFileSync(new URL(import.meta.url))),coreSha256:sha(readFileSync(new URL('./anyraid-captured-ieee-core.mjs',import.meta.url))),sourceSha256:{filter:sha(readFileSync('host/src/diagnostics/motion-filters.ts')),graph:sha(readFileSync('host/src/diagnostics/graph-motion.ts'))},controls,constants:{n,margin,weight:hex(weight),pi:hex(pi),dt:hex(dt),omega2:hex(omega2),damping:hex(damping)},comparisons,scope:'Full saved scalar arrays only, with integer emulation of normal binary64 round-to-nearest ties-to-even operations. Does not import or invoke original simulation/filter, rerun the failed test, prove temporal input integrity, identify runtime/compiler/hardware root cause, cover unrelated failures or close G3.'};
writeFileSync(process.argv[3],JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({controls:controls.length,comparisons:comparisons.map(({stage,length,bitDifferences,aboveOriginalTolerance})=>({stage,length,bitDifferences,aboveOriginalTolerance}))}));
