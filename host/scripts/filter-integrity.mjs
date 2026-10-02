// Reduced weighted4 workload with independently computed C expected output.
import {readFileSync,writeFileSync} from 'node:fs';
const rounds=Number(process.argv[3]);if(process.argv.length!==4||!Number.isSafeInteger(rounds)||rounds<1||rounds>10000)throw Error('Expected fixture and rounds 1..10000');
const bytes=readFileSync(process.argv[2]);if(bytes.length%16||bytes.length<16016||bytes.length>1600000)throw Error('Invalid filter fixture');const count=bytes.length/16,input=Array.from({length:count},(_,i)=>bytes.readDoubleLE(i*8)),expected=Array.from({length:count},(_,i)=>bytes.readDoubleLE((count+i)*8));
if(!input.every(Number.isFinite)||!expected.every(Number.isFinite))throw Error('Non-finite fixture');
function weighted4(data){
 const n=83,weight=15/(16*n**5),out=Array(data.length).fill(0);
 for(let i=500;i<data.length-500;i++){
  let high=0,low=0;
  for(let j=i-n;j<i+n;j++){const d=j-i,value=data[j]*(n**2-d**2)**2,next=high+value;low+=Math.abs(high)>=Math.abs(value)?(high-next)+value:(value-next)+high;high=next;}
  out[i]=(high+low)*weight;
 }
 return out;
}
const bits=x=>{const b=Buffer.alloc(8);b.writeDoubleLE(x);return b.readBigUInt64LE().toString(16);};
let failed=false;for(let run=0;run<rounds&&!failed;run++){
 const output=weighted4(input);
 for(let index=0;index<count;index++){
  const actual=output[index],target=expected[index],difference=actual-target;
  if(!Number.isFinite(actual)||Math.abs(difference)>1e-13){
   const report={run,index,actual,target,difference,actualBits:bits(actual),targetBits:bits(target)};
   // Preserve original output before leaving the reduced process.
   const capture=Buffer.alloc(count*8);output.forEach((v,i)=>capture.writeDoubleLE(v,i*8));writeFileSync(process.argv[2]+'.failure-'+process.pid+'.f64',capture,{flag:'wx'});report.recomputed=weighted4(input)[index];console.log(JSON.stringify(report));failed=true;break;
  }
 }
}
if(failed)process.exitCode=2;else console.log(`filter:verified:${rounds}:${count}`);
