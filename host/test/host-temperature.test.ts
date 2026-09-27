import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {HostTemperature,parseHostTemperature} from '../src/thermal/host-temperature.ts';
test('host millidegree conversion preserves fractions and rejects malformed or unsafe values',()=>{
 for(const [raw,value] of [['42000\n',42],['-1250',-1.25],['4.2123456789e4',42.123456789]] as const)assert.equal(parseHostTemperature(raw,-40,100),value);
 for(const raw of ['', 'NaN','Infinity','12oops','100001','-40001','0x10'])assert.throws(()=>parseHostTemperature(raw,-40,100));
});
test('host source reads asynchronously, retains extrema, faults on corruption and joins close',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'host-temperature-')),path=join(dir,'temp');let faults=0;let source:HostTemperature|undefined;
 try{
  await writeFile(path,'42125\n');source=await HostTemperature.open({section:'temperature_sensor host',path,minimum:0,maximum:100,gcodeId:'H'},()=>{faults++;},new AbortController().signal);
  await source.start(new AbortController().signal);assert.equal(source.state.getTemperature().temperature,42.125);assert.equal(source.state.objectStatus.temperature,42.12);assert.equal(source.state.getTemperature().target,0);
  await writeFile(path,'broken\n');const until=performance.now()+3000;while(!faults){assert(performance.now()<until);await delay(10);}assert.equal(faults,1);assert(source.state.getTemperature().stale);assert.equal(source.state.getTemperature().temperature,42.125);await source.close();await source.close();assert.equal(faults,1);
 }finally{await source?.close();await rm(dir,{recursive:true,force:true});}
});
test('host source rejects directories, missing files, cancelled open and oversized values',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'host-temperature-invalid-')),path=join(dir,'temp'),config={section:'temperature_sensor host',path,minimum:0,maximum:100,gcodeId:undefined};
 try{
  await assert.rejects(HostTemperature.open(config,()=>{},new AbortController().signal));await mkdir(path);await assert.rejects(HostTemperature.open(config,()=>{},new AbortController().signal),/regular file/);await rm(path,{recursive:true});
  await writeFile(path,'1'.repeat(129));await assert.rejects(HostTemperature.open(config,()=>{},AbortSignal.abort(new Error('cancelled'))),/cancelled/);
  let faults=0;const source=await HostTemperature.open(config,()=>{faults++;},new AbortController().signal);try{await assert.rejects(source.start(new AbortController().signal),/size/);assert.equal(faults,1);assert(source.state.getTemperature().stale);}finally{await source.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('host conversions match fixed Python reference without display rounding',async()=>{
 const {readFileSync}=await import('node:fs'),reference=JSON.parse(readFileSync(new URL('../contracts/host-temperature-reference.json',import.meta.url),'utf8'));
 for(const row of reference.rows)assert.equal(parseHostTemperature(row.raw,-273.15,100),row.value);
});
test('duplicate host object names fail during hardware planning',async()=>{
 const {hardwareFixture,hardwareReader,hardwareClocks,hardwareLayout}=await import('./helpers/configured-hardware.ts');
 const {compileConfiguredHardware}=await import('../src/config/hardware.ts'),{ConfigurationReader}=await import('../src/moonraker/config-reader.ts'),{ConfigurationSource}=await import('../src/moonraker/config-source.ts');
 const f=hardwareFixture(),names=['temperature_sensor first host','temperature_sensor second host'],r=new ConfigurationReader(new ConfigurationSource('/duplicate.cfg',{...hardwareReader().source.original,...Object.fromEntries(names.map(n=>[n,{sensor_type:'temperature_host'}]))},[]),null);
 assert.throws(()=>compileConfiguredHardware(r,f.group,hardwareClocks(),{...hardwareLayout,sensors:names.map(section=>({section}))}),/Duplicate host temperature/);
});
