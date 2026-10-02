import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MotanLogManager} from '../src/motan/log-manager.ts';
import {MotanAnalyzer} from '../src/motan/analyzer.ts';
import {managerFixture} from './helpers/motan-manager-fixture.ts';
import {analysisNames,analysisOracle} from './helpers/motan-analysis-oracle.ts';
test('Motan Butterworth analysis preserves source labels, Python integers and all three filter families',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-butter-analysis-')),prefix=join(dir,'log');
 const names=['sos(accelerometer(a,x),filt,lowpass,３,10.5)',
  'sos(accelerometer(a,x),filtfilt,highpass,4,50.5)',
  'sos(accelerometer(a,x),filtfilt,bandpass,1_0,20.25,100.25)',
  'sos(accelerometer(a,x),filt,lowpass,0,10)'];
 try{await managerFixture(prefix);const expected=analysisOracle(prefix,names,.001,1.5),manager=await MotanLogManager.open(prefix);
  try{const analyzer=new MotanAnalyzer(manager,.001);for(const name of names)analyzer.addDataset(name);
   const actual=await analyzer.generate(1.5);assert.deepEqual(Array.from(actual.times),expected.times);
   for(const [name,values] of Object.entries(actual.datasets)){
    for(let i=0;i<values.length;i++)assert.ok(Math.abs(values[i]-expected.data[name][i])<2e-10,name);
    assert.deepEqual({label:actual.labels[name].label,units:actual.labels[name].units},expected.labels[name]);
   }
  }finally{await manager.close();}
  const limited=await MotanLogManager.open(prefix);try{
   const analyzer=new MotanAnalyzer(limited,.001,{maxNumericBytes:1000});
   analyzer.addDataset('sos(accelerometer(a,x),filtfilt,bandpass,64,20,100)');
   await assert.rejects(analyzer.generate(.001),/memory limit/);assert.equal(limited.status.started,false);
  }finally{await limited.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('Motan notch analysis matches original Python through nested datasets, labels and filtering',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-notch-analysis-')),prefix=join(dir,'log');
 const names=['sos(accelerometer(a,x),filt,notch,10.25,30.25)',
  'sos(accelerometer(a,x),filtfilt,notch,20.125,10)',
  'sos(sos(accelerometer(a,x),filt,notch,10.25,30.25),filtfilt,notch,40,12)'];
 try{await managerFixture(prefix);const expected=analysisOracle(prefix,names,.001,1.5),manager=await MotanLogManager.open(prefix);
  try{const analyzer=new MotanAnalyzer(manager,.001);for(const name of names)analyzer.addDataset(name);
   const actual=await analyzer.generate(1.5);assert.deepEqual(Array.from(actual.times),expected.times);
   for(const [name,values] of Object.entries(actual.datasets)){
    for(let i=0;i<values.length;i++)assert.ok(Math.abs(values[i]-expected.data[name][i])<2e-10,name);
    assert.deepEqual({label:actual.labels[name].label,units:actual.labels[name].units},expected.labels[name]);
   }
  }finally{await manager.close();}
  const limited=await MotanLogManager.open(prefix);try{
   const analyzer=new MotanAnalyzer(limited,.001,{maxNumericBytes:700});
   analyzer.addDataset(names[1]);await assert.rejects(analyzer.generate(.02),/memory limit/);
   assert.equal(limited.status.started,false);
  }finally{await limited.close();}
  for(const name of ['sos(accelerometer(a,x),bad,notch,10,30)',
   'sos(accelerometer(a,x),filt,notch,600,30)',
   'sos(accelerometer(a,x),filt,notch,10,30,1)']){
   const manager=await MotanLogManager.open(prefix);try{
    const analyzer=new MotanAnalyzer(manager,.001);assert.throws(()=>analyzer.addDataset(name),/mode|Nyquist|parameters/);
    assert.equal(manager.status.started,false);
   }finally{await manager.close();}
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('Motan analyzer dependency order, accumulated time grid, labels and numerical outputs match original full analysis',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-analysis-')),prefix=join(dir,'log');try{await managerFixture(prefix);const expected=analysisOracle(prefix,analysisNames,.01,.4),manager=await MotanLogManager.open(prefix);try{const analyzer=new MotanAnalyzer(manager,.01);for(const name of analysisNames)analyzer.addDataset(name);const result=await analyzer.generate(.4);assert.deepEqual(Array.from(result.times),expected.times);for(const [name,values] of Object.entries(result.datasets)){assert.deepEqual(Array.from(values),expected.data[name],name);const info=result.labels[name];assert.deepEqual({label:info.label,units:info.units},expected.labels[name]);}assert.equal(Object.keys(result.datasets).length,Object.keys(expected.data).length);await assert.rejects(analyzer.generate(.4),/once/);}finally{await manager.close();}}finally{await rm(dir,{recursive:true,force:true});}
});
test('Motan analyzer rejects unsupported filters and enforces sample/memory/registration limits before reading',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-analysis-limits-')),prefix=join(dir,'log');try{await managerFixture(prefix);for(const options of [{maxSamples:2},{maxNumericBytes:1}]){const manager=await MotanLogManager.open(prefix);try{const analyzer=new MotanAnalyzer(manager,.01,options);analyzer.addDataset('trapq(toolhead,x)');await assert.rejects(analyzer.generate(1),/limit/);assert.equal(manager.status.started,false);}finally{await manager.close();}}const manager=await MotanLogManager.open(prefix);try{const analyzer=new MotanAnalyzer(manager,.01);assert.throws(()=>analyzer.addDataset('sos(trapq(toolhead,x),filt,bandstop,2,10)'),/Unknown Motan SOS filter/);await assert.rejects(analyzer.generate(),/Unknown Motan SOS filter/);}finally{await manager.close();}}finally{await rm(dir,{recursive:true,force:true});}
});
test('Motan nested dataset whitespace is normalized and numeric analysis refuses missing diagnostic samples',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-analysis-normalize-')),prefix=join(dir,'log');try{await managerFixture(prefix);let manager=await MotanLogManager.open(prefix);try{const analyzer=new MotanAnalyzer(manager,.01);analyzer.addDataset(' derivative( trapq(toolhead,x) ) ');const result=await analyzer.generate(.1);assert.ok(result.datasets['trapq(toolhead,x)']);assert.ok(result.datasets['derivative( trapq(toolhead,x) )']);}finally{await manager.close();}manager=await MotanLogManager.open(prefix);try{const analyzer=new MotanAnalyzer(manager,1);analyzer.addDataset('stallguard(stepper_x,sg_result)');await assert.rejects(analyzer.generate(10),/cannot represent/);}finally{await manager.close();}}finally{await rm(dir,{recursive:true,force:true});}
});
test('Motan cartesian/CoreXY axis mapping and an unrepresentable time increment are explicit',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-kin-analysis-'));try{for(const kin of ['cartesian','corexy'] as const){const prefix=join(dir,kin);await managerFixture(prefix,2,kin);const names=['kin(stepper_x)','kin(stepper_y)','kin(stepper_z)'],expected=analysisOracle(prefix,names,.01,.1),manager=await MotanLogManager.open(prefix);try{const analyzer=new MotanAnalyzer(manager,.01);for(const name of names)analyzer.addDataset(name);const result=await analyzer.generate(.1);for(const name of names)assert.deepEqual(Array.from(result.datasets[name]),expected.data[name]);}finally{await manager.close();}const tinyManager=await MotanLogManager.open(prefix);try{const analyzer=new MotanAnalyzer(tinyManager,Number.MIN_VALUE);analyzer.addDataset('trapq(toolhead,x)');await assert.rejects(analyzer.generate(1),/advance/);assert.equal(tinyManager.status.started,false);}finally{await tinyManager.close();}}}finally{await rm(dir,{recursive:true,force:true});}
});
