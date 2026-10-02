import {legacyMotanCsv,legacyMotanCsvTiming} from '../test/helpers/motan-export-reference.ts';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {MotanTypedPhaseSampler,motanTypedPhaseConfig} from '../src/motan/typed-phase-samples.ts';
import {MotanPhaseSampler,motanPhaseConfig} from '../src/motan/phase-samples.ts';
import {motionCase} from '../test/helpers/motan-motion-oracle.ts';
import {typedPhaseOracle} from '../test/helpers/motan-typed-phase-oracle.ts';
import {scalarBits} from '../test/helpers/motan-scalar-oracle.ts';
import {parseTypedMotanJson,motanTypedValue} from '../src/motan/number-types.ts';
import {encodeMotanJson} from '../src/motan/capture.ts';
import type {StepBlock} from '../src/motan/motion-samples.ts';
const stats=(ms:number[])=>{ms.sort((a,b)=>a-b);return {median:ms[Math.floor(ms.length/2)],p95:ms[Math.ceil(ms.length*.95)-1]};};
const rawJSON=(JSON as unknown as {rawJSON:(text:string)=>unknown}).rawJSON;
for(const count of [600,16000])for(const floating of [false,true]){
 const input=motionCase(count),raw=encodeMotanJson({settings:{'tmc2209 stepper_x':{},stepper_x:{microsteps:256}},blocks:input.blocks.map(b=>({...b,start_mcu_position:floating?rawJSON('9007199254740992.0'):b.start_mcu_position})),offsets:[[0,floating?rawJSON('0.25'):-9007199254740997n]],times:input.times}).toString(),reference=typedPhaseOracle(raw,false,true);
 const x=parseTypedMotanJson(raw) as {settings:Record<string,unknown>;blocks:StepBlock[];offsets:unknown[][];times:number[]},offset=motanTypedValue(x.offsets[0] as unknown as Record<string,unknown>,'1'),ms:number[]=[],old:number[]=[];
 for(let run=0;run<35;run++)for(const mode of run%2?['typed','legacy']:['legacy','typed']){
  if(mode==='legacy'&&floating)continue;
  let at=0;const status=async()=>({status:{'tmc2209 stepper_x':{mcu_phase_offset:offset}},nextTime:1e9}),steps=async()=>x.blocks[at++]??null,start=performance.now();
  const sampler=mode==='typed'?new MotanTypedPhaseSampler(motanTypedPhaseConfig(x.settings,'tmc2209 stepper_x'),steps,status):new MotanPhaseSampler(motanPhaseConfig(x.settings,'tmc2209 stepper_x'),steps,status),values=[];
  for(const time of x.times)values.push(await sampler.sample(time));const elapsed=performance.now()-start;
  // Legacy represents integer residues as Number; compare values after restoring
  // its known integer result type only for this all-integer benchmark fixture.
  assert.deepEqual(scalarBits(mode==='legacy'?values.map(BigInt):values),reference.values);
  if(run>=20)(mode==='typed'?ms:old).push(elapsed);
 }
 console.log(JSON.stringify({node:process.version,stepsPerBlock:count*2,samples:x.times.length,floating,pythonMs:stats(reference.ms),typedMs:stats(ms),legacyMs:old.length?stats(old):undefined,exactTypesAndBits:true,scope:'Decode, validation, async sampling and result allocation; excludes parsing/gzip/worker. Node 20 warmups/15 runs; Python 2/7. Legacy integer-only sampler is unchanged.'}));
}

// Real reader/worker path measures the optional stepq token parser as well.
const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{fileURLToPath}=await import('node:url'),{execFileSync}=await import('node:child_process'),{managerFixture}=await import('../test/helpers/motan-manager-fixture.ts');
const dir=await mkdtemp(join(tmpdir(),'motan-phase-csv-bench-')),prefix=join(dir,'log'),root=fileURLToPath(new URL('../../',import.meta.url));
try{
 await managerFixture(prefix,10);const common=[prefix,'-c','["step_phase(tmc2209 stepper_x)"]','-d','20','--segment-time','.001'],outputs:string[]=[legacyMotanCsv(common)];
 console.log(JSON.stringify({scope:'Captured original CSV process timing',historicalPythonMs:legacyMotanCsvTiming(common)}));
 for(const mode of ['node','typed']){
  const args=[join(root,'scripts/motan/data_export.ts'),prefix,'-c','["step_phase(tmc2209 stepper_x)"]','-d','20','--segment-time','.001',...(mode==='typed'?['--preserve-number-types']:[])],ms:number[]=[];let output='';
  for(let run=0;run<9;run++){const start=performance.now();output=execFileSync(process.execPath,args,{encoding:'utf8',env:{...process.env,PATH:'/no-programs'},maxBuffer:16*1024**2,timeout:30000});if(run>=2)ms.push(performance.now()-start);}
  outputs.push(output);console.log(JSON.stringify({scope:'20000 phase CSV samples including startup, gzip, parsing, worker, analysis and stdout; 2 warmups/7 runs',mode,ms:stats(ms)}));
 }
 const rows=(text:string)=>text.trimEnd().split('\r\n').slice(1).map(line=>line.split(',').map(Number));assert.deepEqual(rows(outputs[1]),rows(outputs[0]));assert.deepEqual(rows(outputs[2]),rows(outputs[0]));console.log(JSON.stringify({csvNumericExact:true}));
}finally{await rm(dir,{recursive:true,force:true});}
