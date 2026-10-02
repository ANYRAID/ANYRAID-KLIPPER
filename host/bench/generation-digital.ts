import assert from 'node:assert/strict';
import {compileDigital,DigitalOutput} from '../src/outputs/digital.ts';
import {GenerationDigitalOutput} from '../src/outputs/generation-digital.ts';
import {stepperBatchFixture} from '../test/helpers/configured-steppers.ts';
const f=stepperBatchFixture(),mcu=f.mcus.get('mcu')!;
const config=compileDigital(mcu.chip,mcu.dictionary,{oid:0,pin:f.pins.parse('PA2'),maxDuration:0});
const signal=new AbortController().signal,clock=(t:number)=>BigInt(t);
const samples:{legacyMs:number;generationMs:number}[]=[];
const iterations=10000;
for(let run=0;run<10;run++){
 const times={legacyMs:0,generationMs:0};
 // Alternate order to reduce bias from warm caches or background load.
 for(const generation of run%2?[true,false]:[false,true]){
  let sends=0,bytes=0;
  const data={async send(payload:Uint8Array){sends++;bytes+=payload.length;},async stop(){}};
  const control={async send(){},async stop(){}};
  const output=generation?new GenerationDigitalOutput(config,mcu.dictionary,data,control,clock):new DigitalOutput(config,mcu.dictionary,data,clock);
  if(output instanceof GenerationDigitalOutput)await output.reset(signal);
  const start=performance.now();
  for(let i=0;i<iterations;i++)await output.setDigital(i,Boolean(i&1),signal);
  times[generation?'generationMs':'legacyMs']=performance.now()-start;
  assert.equal(sends,iterations);assert.ok(bytes>iterations);
  if(output instanceof GenerationDigitalOutput){assert.equal(output.status.pendingWrites,0);await output.stop();}
 }
 if(run>=3)samples.push(times);
}
console.log(JSON.stringify({node:process.version,iterations,warmups:3,samples,
 medianLegacyMs:samples.map(s=>s.legacyMs).sort((a,b)=>a-b)[3],
 medianGenerationMs:samples.map(s=>s.generationMs).sort((a,b)=>a-b)[3],
 scope:'Sequential encoding and host lifecycle with immediate mock ACK; no serial transport, MCU execution or print acceptance'},null,2));
