// Diagnostic source copy only. Never patches a product module or changes a gate.
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const filterSha256='fc3cc774cd6d5201e93ee8047ef4bca56f53162800f170c06b2429f98d6e90eb';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function once(source:string,from:string,to:string):string{
 if(source.split(from).length!==2)throw new Error('Filter trace anchor changed');
 return source.replace(from,to);
}
export function traceMotionFilter(source:string):string{
 if(hash(source)!==filterSha256)throw new Error('Filter trace requires its reviewed source fingerprint');
 source="let capturedFilterCalls:any[]=[];\nexport function drainFilterTrace(){const calls=capturedFilterCalls;capturedFilterCalls=[];return calls;}\n"+source;
 source=once(source," const out=Array<number>(data.length).fill(0);"," const traceCall=filter==='weighted4'?{inputBefore:Array.from(data),inputAfter:[] as number[],points:[] as any[],weight:NaN}:undefined;\n const out=Array<number>(data.length).fill(0);");
 source=once(source," for(let i=margin;i<data.length-margin;i++){"," if(traceCall)traceCall.weight=weight;\n for(let i=margin;i<data.length-margin;i++){\n  const tracePoint=traceCall&&[4398,4399,7855,7856,8661,8662].includes(i)?{index:i,n,steps:[] as any[],sum:NaN,output:NaN}:undefined;\n  if(tracePoint)traceCall!.points.push(tracePoint);");
 source=once(source,"for(let j=first;j<i+n;j++){const d=j-i,abs=Math.abs(d),value=","for(let j=first;j<i+n;j++){const highBefore=high,lowBefore=low,sample=data[j];const d=j-i,abs=Math.abs(d),value=");
 // Capture the actual single-read operand. Keep every arithmetic expression
 // and evaluation order; this diagnostic condition can still affect JIT shape.
 source=once(source,"filter==='smooth'?data[j]:filter==='weighted'?data[j]*(n-abs):filter==='weighted2'?data[j]*(n**2-d**2):filter==='weighted3'?data[j]*(n-abs)**2*(2*abs+n):data[j]*(n**2-d**2)**2","filter==='smooth'?sample:filter==='weighted'?sample*(n-abs):filter==='weighted2'?sample*(n**2-d**2):filter==='weighted3'?sample*(n-abs)**2*(2*abs+n):sample*(n**2-d**2)**2");
 source=once(source,"high=next;}","high=next;if(tracePoint)tracePoint.steps.push({index:j,d,abs,sample,value,next,highBefore,lowBefore,high,low});}");
 source=once(source,"out[i]=(high+low)*weight;","const sum=high+low;out[i]=sum*weight;if(tracePoint){tracePoint.sum=sum;tracePoint.output=out[i];}");
 source=once(source,"throw new RangeError('Motion filter overflow');return out;","throw new RangeError('Motion filter overflow');if(traceCall){traceCall.inputAfter=Array.from(data);capturedFilterCalls.push(traceCall);}return out;");
 return source;
}
export function prepareTracedMotionModules(host:string,root:string){
 const directory=join(root,'src/diagnostics');mkdirSync(directory,{recursive:true});
 const sources:Record<string,{originalSha256:string;observedSha256:string}>={};
 for(const name of ['motion-filters.ts','graph-motion.ts','legacy-motion-shaper.ts']){
  const original=readFileSync(join(host,'src/diagnostics',name),'utf8');
  const observed=name==='motion-filters.ts'?traceMotionFilter(original):original;
  writeFileSync(join(directory,name),observed,{flag:'wx',mode:0o600});
  sources[name]={originalSha256:hash(original),observedSha256:hash(observed)};
 }
 return sources;
}
