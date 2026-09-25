import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {calibrationLogFixtures,calibrationCliFixture} from '../contracts/calibration-fixtures.ts';
import {calibrationReference as reference,verifyCalibrationInput,compareCalibrationDatasets} from './helpers/calibration-reference.ts';
import {parseAccelerometerLog,accelerometerDatasets} from '../src/calibration/accelerometer-log.ts';
const cli=fileURLToPath(new URL('../../scripts/calibrate_shaper.ts',import.meta.url));
test('retired calibration parser preserves five independently captured Python NumPy datasets',()=>{
 assert.equal(reference.version,1);assert.match(reference.sources['scripts/calibrate_shaper.py'],/^[a-f0-9]{64}$/);
 for(const [kind,text] of Object.entries(calibrationLogFixtures())){const r=reference.cases[kind];verifyCalibrationInput(text,r.inputSha256);compareCalibrationDatasets(accelerometerDatasets(parseAccelerometerLog(text,kind+'.csv'),true),r.datasets);}
});
test('Python-free CLI matches original fit arrays and metrics and corrects CSV response alignment',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'calibration-retired-'));try{
  const input=join(dir,'input.csv'),report=join(dir,'report.json'),csv=join(dir,'output.csv'),text=calibrationCliFixture();verifyCalibrationInput(text,reference.cli.inputSha256);await writeFile(input,text);
  const stdout=execFileSync(process.execPath,[cli,'--shaper_freq','30:80:5','--report',report,'-c',csv,input],{encoding:'utf8',env:{...process.env,PATH:dir,PYTHON:join(dir,'no-python')}});
  assert.equal(stdout.match(/Recommended shaper is (.+)/)?.[1],reference.cli.performance.recommendation);
  const actual=JSON.parse(await readFile(report,'utf8'));assert.equal(actual.best,reference.cli.fit.best);assert.equal(actual.shapers.length,reference.cli.fit.shapers.length);
  for(const [i,r] of reference.cli.fit.shapers.entries()){
   const s=actual.shapers[i];assert.equal(s.name,r.name);assert.equal(s.frequency,r.frequency);
   for(const key of ['vibrations','smoothing','score','maxAcceleration'] as const)assert(Math.abs(s[key]-r[key])<=1e-9*Math.max(1,Math.abs(r[key])),key);
   for(const key of ['frequencies','values'] as const){assert.equal(s[key].length,r[key].length);r[key].forEach((v,j)=>assert(Math.abs(s[key][j]-v)<=1e-10*Math.max(1,Math.abs(v)),key));}
  }
  const rows=(await readFile(csv,'utf8')).trim().split('\n'),old=reference.cli.csv.trim().split('\n');assert.equal(rows.length,old.length);assert.equal(rows[0].replaceAll('"',''),old[0]);
  for(let i=1;i<rows.length;i++){
   const values=rows[i].split(',').map(Number),legacy=old[i].split(',').map(Number);assert(Math.abs(values[0]-legacy[0])<1e-12);
   for(let j=1;j<=4;j++)assert(Math.abs(values[j]-legacy[j])<=Math.abs(legacy[j])*5.01e-4+1e-300,'Original rounded PSD');
   // The original CSV indexed a 0.2 Hz response array by the 0.9 Hz input
   // row. Compare against the captured physical frequency grid instead.
   reference.cli.fit.shapers.forEach((r,j)=>{const hi=r.frequencies.findIndex(f=>f>=values[0]);assert(hi>=0);const expected=hi===0?r.values[0]:r.values[hi-1]+(r.values[hi]-r.values[hi-1])*(values[0]-r.frequencies[hi-1])/(r.frequencies[hi]-r.frequencies[hi-1]);assert(Math.abs(values[j+6]-expected)<1e-10);});
  }
  assert.equal(await readFile(input,'utf8'),text);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('calibration CLI exports standalone HTML and vector PDF without Python',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'calibration-formats-'));try{
  const input=join(dir,'input.csv');await writeFile(input,calibrationCliFixture());
  for(const extension of ['html','pdf']){const output=join(dir,'plot.'+extension);execFileSync(process.execPath,[cli,'--shapers','mzv,zvd','--shaper_freq','35,45,55','-o',output,input],{env:{...process.env,PATH:dir,PYTHON:join(dir,'no-python')}});const data=await readFile(output);if(extension==='html'){assert.match(data.toString(),/Recommended shaper/);assert.match(data.toString(),/<svg/);assert.doesNotMatch(data.toString(),/<script[^>]+src=/);}else{assert.equal(data.subarray(0,5).toString(),'%PDF-');const extracted=execFileSync('pdftotext',[output,'-'],{encoding:'utf8'});assert.match(extracted,/Recommended shaper/);assert.match(extracted,/sm=0\.\d{3}/);assert.match(extracted.replace(/\s/g,''),/accel<=\d+/);}}
 }finally{await rm(dir,{recursive:true,force:true});}
});
