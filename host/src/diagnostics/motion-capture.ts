import {deserialize} from 'node:v8';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const bits=(value:number)=>{const b=Buffer.alloc(8);b.writeDoubleLE(value);return '0x'+b.readBigUInt64LE().toString(16).padStart(16,'0');};
/** Local diagnostic artifacts only. Analysis does not rerun motion generation or
 * replace the captured arrays; exact derivative invariants are evaluated using
 * inputs retained from the same motionPlots invocation when available. */
export function inspectMotionCapture(input:Uint8Array){
 if(!input.length||input.length>32*1024*1024)throw new Error('Invalid motion capture size');const bytes=input[0]===31&&input[1]===139?gunzipSync(input,{maxOutputLength:64*1024*1024}):input;
 const c=deserialize(bytes);if(!c||![1,2,3].includes(c.version)||!Array.isArray(c.positions)||!c.reference)throw new Error('Invalid motion capture');
 const differences:{stage:string;count:number;examples:{index:number;actual:number;expected:number;actualBits:string;expectedBits:string}[]}[]=[];
 const compare=(stage:string,actual:unknown,expected:unknown,tolerance=0)=>{
  if(!Array.isArray(actual)||!Array.isArray(expected)||actual.length!==expected.length||actual.length>100000||actual.some(v=>typeof v!=='number')||expected.some(v=>typeof v!=='number'))throw new Error('Invalid captured array: '+stage);
  const examples:{index:number;actual:number;expected:number;actualBits:string;expectedBits:string}[]=[];let count=0;
  for(let index=0;index<actual.length;index++)if(!Number.isFinite(actual[index])||!Number.isFinite(expected[index])||Math.abs(actual[index]-expected[index])>tolerance){count++;if(examples.length<16)examples.push({index,actual:actual[index],expected:expected[index],actualBits:bits(actual[index]),expectedBits:bits(expected[index])});}
  differences.push({stage,count,examples});
 };
 compare('standalone positions vs reference',c.positions,c.reference.positions,1e-12);
 if(Array.isArray(c.panels)){
  if(!Array.isArray(c.reference.panels)||c.panels.length!==c.reference.panels.length)throw new Error('Invalid captured reference panels');
  for(let panel=0;panel<c.panels.length;panel++)for(let curve=0;curve<c.panels[panel].plot.curves.length;curve++)compare('reference panel '+panel+' curve '+curve,c.panels[panel].plot.curves[curve].values,c.reference.panels[panel].curves[curve].values,[1e-8,1e-4,1e-10][panel]??0);
 }
 if(c.stages){
  const s=c.stages,inputs=[s.updated,s.nominal,s.head,s.newHead];compare('plot nominal vs reference',s.nominal,c.reference.positions,1e-12);
  const derivative=(array:number[])=>array.map((value,index)=>index?(value-array[index-1])*10000:0);
  for(let curve=0;curve<4;curve++){
   if(!Array.isArray(inputs[curve]))throw new Error('Missing derivative input');compare('velocity '+curve+' vs captured input derivative',s.velocity[curve],derivative(inputs[curve]));
   compare('acceleration '+curve+' vs captured velocity derivative',s.acceleration[curve],derivative(s.velocity[curve]));
   compare('velocity panel '+curve+' vs raw stage',c.panels[0].plot.curves[curve].values,s.velocity[curve].slice(0,c.panels[0].plot.curves[curve].values.length));
   compare('acceleration panel '+curve+' vs raw stage',c.panels[1].plot.curves[curve].values,s.acceleration[curve].slice(0,c.panels[1].plot.curves[curve].values.length));
  }
 }
 const comparison=c.comparison?{...c.comparison,recomputedDifference:c.comparison.actual-c.comparison.expected,recomputedWithin:Math.abs(c.comparison.actual-c.comparison.expected)<=c.comparison.tolerance}:undefined;
 return {comparison,version:c.version,kind:c.kind??'curves',run:c.run,panel:c.panel,curve:c.curve,index:c.index,compressedSHA256:sha(input),rawSHA256:sha(bytes),sameInvocationInputs:!!c.stages,differences,limitation:'Invariant differences locate inconsistent stored stages; they do not establish the runtime, compiler or hardware root cause.'};
}
