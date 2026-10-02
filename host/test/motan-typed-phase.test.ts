import {legacyMotanCsv} from './helpers/motan-export-reference.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MotanTypedPhaseSampler,motanTypedPhaseConfig} from '../src/motan/typed-phase-samples.ts';
import {parseTypedMotanJson} from '../src/motan/number-types.ts';
import {scalarBits} from './helpers/motan-scalar-oracle.ts';
import {typedPhaseOracle} from './helpers/motan-typed-phase-oracle.ts';
import type {StepBlock} from '../src/motan/motion-samples.ts';
import {MotanAnalysisExecutor} from '../src/motan/analysis-executor.ts';
import {managerFixture} from './helpers/motan-manager-fixture.ts';
import {MotanLogWriter} from '../src/motan/log-writer.ts';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const rawCase=(base:string,offset:string,microsteps='16')=>`{"settings":{"tmc2209 stepper_x":{},"stepper_x":{"microsteps":${microsteps}}},"blocks":[{"first_clock":100,"last_clock":600,"first_step_time":1,"last_step_time":6,"start_mcu_position":${base},"start_position":0,"step_distance":0.01,"data":[[100,3,0],[100,-3,0]]}],"offsets":[[0,${offset}],[2.5,1.0],[5.5,null]],"times":[0,0.5,1,1.5,2,3,4,5,6,6.1,7]}`;
export interface TypedPhaseFixture {settings:Record<string,unknown>;blocks:StepBlock[];offsets:[number,unknown][];times:number[];}
const samplerFor=(raw:string,microstep=false)=>{
 const x=parseTypedMotanJson(raw) as TypedPhaseFixture;let at=0;
 return {x,sampler:new MotanTypedPhaseSampler(motanTypedPhaseConfig(x.settings,'tmc2209 stepper_x',microstep?'microstep':'phase'),async()=>x.blocks[at++]??null,async time=>{
  let i=0;while(i+1<x.offsets.length&&x.offsets[i+1][0]<=time)i++;
  // BigInt marks an integer; a remaining Number is an actual float token.
  const row=x.offsets[i];return {status:{'tmc2209 stepper_x':offsetStatus(row)},nextTime:x.offsets[i+1]?.[0]??1e9};
 })};
};
import {motanTypedValue} from '../src/motan/number-types.ts';
function offsetStatus(row:[number,unknown]):Record<string,unknown>{return {mcu_phase_offset:motanTypedValue(row as unknown as Record<string,unknown>,'1')};}
test('typed phase preserves Python operand types, sequential float steps and modulo bits',async()=>{
 const huge=String(1n<<2000n),cases=[rawCase('9007199254740993','-9007199254740997'),rawCase('9007199254740992.0','0'),rawCase('-9007199254740992.0','1.0'),rawCase('9007199254740993','0','16.0'),rawCase('0','1e-100'),rawCase('0','-1e-100'),rawCase('0','5e-324'),rawCase('0','-5e-324'),rawCase('-0.0','-0.0'),rawCase('true','false'),rawCase('1.25','-0.5'),rawCase(huge,'-'+huge)];
 // The huge integer case must stay integer throughout; a float offset would
 // correctly overflow when Python converts the enormous operand.
 cases[cases.length-1]=cases.at(-1)!.replace('[2.5,1.0]','[2.5,1]');
 for(const raw of cases)for(const microstep of [false,true]){
  const {x,sampler}=samplerFor(raw,microstep),actual=[];for(const time of x.times)actual.push(await sampler.sample(time));assert.deepEqual(scalarBits(actual),typedPhaseOracle(raw,microstep).values);
 }
});
test('typed phase rejects overflow and malformed state permanently and retains expansion/concurrency limits',async()=>{
 const {sampler}=samplerFor(rawCase(String(1n<<2000n),'0.0'));await assert.rejects(sampler.sample(0),/finite/);await assert.rejects(sampler.sample(1),/finite/);
 const config={driverName:'tmc2209 stepper_x',stepperName:'stepper_x',phases:64n};
 assert.throws(()=>new MotanTypedPhaseSampler({...config,phases:0n},async()=>null,async()=>({status:{},nextTime:10})),/configuration/);
 const input=parseTypedMotanJson(rawCase('1','0')) as TypedPhaseFixture;
 await assert.rejects(new MotanTypedPhaseSampler(config,async()=>input.blocks[0],async()=>({status:{},nextTime:10}),2).sample(0),/step limit/);
 await assert.rejects(new MotanTypedPhaseSampler(config,async()=>input.blocks[0],async()=>({status:{},nextTime:100})).sample(10),/block limit/);
 await assert.rejects(new MotanTypedPhaseSampler(config,async()=>null,async()=>({status:{'tmc2209 stepper_x':null},nextTime:10})).sample(0),/object/);
 let release!:(value:null)=>void;const waiting=new MotanTypedPhaseSampler(config,()=>new Promise(resolve=>{release=resolve;}),async()=>({status:{},nextTime:10})),pending=waiting.sample(1);await assert.rejects(waiting.sample(1),/sequential/);release(null);await pending;await assert.rejects(waiting.sample(0),/sequential/);
});
test('typed phase reader and worker retain integer residues through status differences and CSV',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-typed-phase-')),prefix=join(dir,'log'),executor=new MotanAnalysisExecutor();
 try{
  const wide=9007199254740993n;await managerFixture(prefix,2,'corexy',{wide});
  const phase='step_phase(tmc2209 stepper_x)',difference=`deviation(status(export_fields.wide),${phase})`,columns=[phase,difference];
  const result=await executor.analyze({prefix,datasets:columns,output:'table',preserveNumberTypes:true,duration:.02,segmentTime:.01});assert.deepEqual(Array.from(result.datasets[phase]),[36n,36n]);assert.deepEqual(Array.from(result.datasets[difference]),[wide-36n,wide-36n]);
  const root=fileURLToPath(new URL('../../',import.meta.url)),args=[prefix,'-c',JSON.stringify(columns),'-d','.02','--segment-time','.01'];
  const node=execFileSync(process.execPath,[join(root,'scripts/motan/data_export.ts'),...args,'--preserve-number-types'],{encoding:'utf8',env:{...process.env,PATH:'/no-programs'}}),python=legacyMotanCsv(args);assert.equal(node,python);
 }finally{await executor.close();await rm(dir,{recursive:true,force:true});}
});

test('float phase tokens survive compressed stepq/status/config records and match Python CSV types and bits',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-phase-float-log-')),executor=new MotanAnalysisExecutor();
 try{
  const {encodeMotanJson}=await import('../src/motan/capture.ts');
  for(const [i,raw] of [rawCase('9007199254740992.0','-1e-100'),rawCase('9007199254740993','-9007199254740993','16.0'),rawCase('9007199254740993','0')].entries()){
   const x=parseTypedMotanJson(raw) as TypedPhaseFixture,prefix=join(dir,String(i)),writer=await MotanLogWriter.open(prefix+'.json.gz'),index=await MotanLogWriter.open(prefix+'.index.gz');
   const initial={toolhead:{estimated_print_time:0},configfile:{settings:x.settings},'tmc2209 stepper_x':offsetStatus(x.offsets[0])};
   // offsetStatus exposes explicit floats as Number; preserve their token kind
   // through reserialization with metadata instead of JSON integer spelling.
   initial['tmc2209 stepper_x']=parseTypedMotanJson(`{"mcu_phase_offset":${raw.match(/"offsets":\[\[0,([^\]]+)/)![1]}}`) as Record<string,unknown>;
   try{
    await index.addData(encodeMotanJson({status:initial,subscriptions:{'stepq:stepper_x':{}},file_position:0}));
    await writer.addData(encodeMotanJson({q:'status',params:{status:initial}}));
    await writer.addData(encodeMotanJson({q:'stepq:stepper_x',params:x.blocks[0]}));
    for(const [time,token] of [[2.5,'1.0'],[5.5,'null']] as const)await writer.addData(Buffer.from(`{"q":"status","params":{"status":{"toolhead":{"estimated_print_time":${time}},"tmc2209 stepper_x":{"mcu_phase_offset":${token}}}}}`));
   }finally{await writer.close();await index.close();}
   const columns=['step_phase(tmc2209 stepper_x)','step_phase(tmc2209 stepper_x,microstep)'],result=await executor.analyze({prefix,datasets:columns,output:'table',preserveNumberTypes:true,duration:7,segmentTime:.5}),root=fileURLToPath(new URL('../../',import.meta.url));
   const csv=legacyMotanCsv([prefix,'-c',JSON.stringify(columns),'-d','7','--segment-time','.5']),rows=csv.trimEnd().split('\r\n').slice(1).map(line=>line.split(','));
   for(const [j,column] of columns.entries()){
    const expected=rows.map(row=>/[.eE]/.test(row[j+1])?Number(row[j+1]):BigInt(row[j+1]));
    assert.deepEqual(scalarBits(result.datasets[column]),scalarBits(expected));
   }
  }
 }finally{await executor.close();await rm(dir,{recursive:true,force:true});}
});
