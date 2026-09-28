import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {loadKlipperConfiguration} from '../src/config/klipper-files.ts';
import {deltaCalibrationSaveChanges,readDeltaCalibrationState} from '../src/config/delta-calibration-state.ts';
import {fitDeltaCalibration} from '../src/calibration/delta-calibration.ts';
import {asymmetricDeltaCalibration} from './helpers/delta-calibration.ts';
test('Delta calibration saves and restores full precision geometry and observations with stale entries removed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'delta-save-')),path=join(dir,'printer.cfg');
 try{
  const initial='[printer]\nkinematics: delta\ndelta_radius: 100\n[delta_calibrate]\nradius: 65\n';await writeFile(path,initial);
  const input=asymmetricDeltaCalibration()[1],result=fitDeltaCalibration(input),{session}=await KlipperSaveSession.load(path);
  session.apply([{kind:'set',section:'delta_calibrate',option:'height998',value:'5'},{kind:'set',section:'delta_calibrate',option:'height998_pos',value:'1,2,3'}]);
  session.apply(deltaCalibrationSaveChanges(input,result));const saved=await session.save();assert(saved&&!saved.pending);session.sealForRestart();
  assert.equal(await readFile(saved.backupPath,'utf8'),initial);assert(session.status.sealedForRestart);
  const source=await loadKlipperConfiguration(path),reader=new ConfigurationReader(source,null);
  assert.deepEqual(readDeltaCalibrationState(reader),{probes:input.probes,manual:[],distances:input.distances});
  assert.equal(source.original.delta_calibrate.radius,'65');assert(!Object.hasOwn(source.original.delta_calibrate,'height998'));
  assert.equal(Number(source.original.printer.delta_radius),result.geometry.radius);
  for(const [i,a] of ['a','b','c'].entries())for(const [option,values] of [['angle',result.geometry.angles],['arm_length',result.geometry.arms],['position_endstop',result.geometry.endstops]] as const)assert.equal(Number(source.original['stepper_'+a][option]),values[i]);
  assert.throws(()=>deltaCalibrationSaveChanges(input,{...result,search:{...result.search,converged:false}}),/unsuccessful/);
  const next=(await KlipperSaveSession.load(path)).session;next.apply(deltaCalibrationSaveChanges(input,result));await writeFile(path,(await readFile(path,'utf8'))+'# concurrent edit\n');await assert.rejects(next.save(),/changed|modified/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('Delta restore rejects gaps and orphaned vectors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'delta-invalid-')),path=join(dir,'printer.cfg');
 try{for(const text of ['height1: 0\nheight1_pos: 1,2,3','height0_pos: 1,2,3','height0: 0\nheight0_pos: 1,2']){
  await writeFile(path,'[delta_calibrate]\n'+text+'\n');const source=await loadKlipperConfiguration(path);assert.throws(()=>readDeltaCalibrationState(new ConfigurationReader(source,null)));
 }}finally{await rm(dir,{recursive:true,force:true});}
});
