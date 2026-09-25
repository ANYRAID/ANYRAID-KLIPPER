import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {graphAccelerationFixture,spectrogramFixture,accelerationBytes,spectrogramCsvFixture} from '../contracts/accelerometer-fixtures.ts';
import {accelerometerReference as ref,verifyAccelerationInput,compareAccelerationPlots,compareSpectrogram,compareSpectrogramCsv} from './helpers/accelerometer-reference.ts';
import {spectrogramCsv} from '../src/calibration/spectrogram-csv.ts';
import {parseAccelerometerLog} from '../src/calibration/accelerometer-log.ts';
import {accelerometerPlots} from '../src/diagnostics/graph-accelerometer.ts';
import {calculateSpectrogram} from '../src/calibration/spectrogram.ts';
const cli=fileURLToPath(new URL('../../scripts/graph_accelerometer.ts',import.meta.url));
test('retired CSV reference preserves matrix shape while Node retains full double precision',()=>{const data=spectrogramCsvFixture();assert.equal(compareSpectrogramCsv(spectrogramCsv(data),data).maxRoundTripError,0);});
test('retired raw and frequency plot functions preserve captured NumPy curves',()=>{
 const text=graphAccelerationFixture();for(const raw of [true,false]){const reference=ref.graphs[raw?'raw':'frequency'];verifyAccelerationInput(text,reference.inputSha256);compareAccelerationPlots(accelerometerPlots([parseAccelerometerLog(text,'raw.csv')],{raw}),reference);}
});
test('six retired matplotlib spectrogram matrices preserve padding, grid, axes and every cell',()=>{
 for(const reference of Object.values(ref.spectra)){const raw=spectrogramFixture(reference.n,reference.rate);verifyAccelerationInput(accelerationBytes(raw),reference.inputSha256);compareSpectrogram(calculateSpectrogram(raw,reference.axis),reference);}
});
test('Python-free accelerometer CLI covers raw, frequency comparison, axis selection and full spectrogram CSV',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'accelerometer-retired-'));try{
  const input=join(dir,'raw.csv'),output=join(dir,'plot.json'),text=graphAccelerationFixture();await writeFile(input,text);
  const env={...process.env,PATH:dir,PYTHON:join(dir,'no-python')},run=(args:string[])=>execFileSync(process.execPath,[cli,'-o',output,...args],{env});
  run(['-r',input]);compareAccelerationPlots(JSON.parse(await readFile(output,'utf8')),ref.graphs.raw);
  const pdf=join(dir,'raw.pdf');execFileSync(process.execPath,[cli,'-r','-o',pdf,input],{env});const pdfText=execFileSync('pdftotext',[pdf,'-'],{encoding:'utf8'});assert.match(pdfText.replace(/\s/g,''),/raw\.csv\([+-][\d.]+mm\/s\^2\)/);
  run([input]);compareAccelerationPlots(JSON.parse(await readFile(output,'utf8')),ref.graphs.frequency);
  run(['-c',input,input]);const compared=JSON.parse(await readFile(output,'utf8'));assert.equal(compared[0].plot.curves.length,2);for(const curve of compared[0].plot.curves)compareAccelerationPlots([{...compared[0],plot:{...compared[0].plot,curves:[curve]}}],{...ref.graphs.frequency,plots:[[ref.graphs.frequency.plots[0][0]]]});
  run(['-a','x',input]);compareAccelerationPlots(JSON.parse(await readFile(output,'utf8')),{...ref.graphs.frequency,plots:[[ref.graphs.frequency.plots[0][1]]]});
  const reference=ref.spectra['512-1000-x'],raw=spectrogramFixture(reference.n,reference.rate),short=join(dir,'short.csv'),csv=join(dir,'spec.csv');await writeFile(short,Array.from({length:reference.n},(_,i)=>Array.from(raw.subarray(i*4,i*4+4)).join(',')).join('\n'));
  run(['-s','-a','x',short]);const spectrum=JSON.parse(await readFile(output,'utf8'));compareSpectrogram({...spectrum,power:Float64Array.from(spectrum.power),times:Float64Array.from(spectrum.times),frequencies:Float64Array.from(spectrum.frequencies)},reference);
  execFileSync(process.execPath,[cli,'-s','-a','x','-f','10','-o',csv,short],{env});const rows=(await readFile(csv,'utf8')).trim().split('\n');assert.equal(rows.length,reference.f.length+1);const times=rows[0].split(',').slice(1).map(Number);assert.deepEqual(times,reference.t);
  const power:number[]=[];rows.slice(1).forEach((row,i)=>{const values=row.split(',').map(Number);assert.equal(values[0],reference.f[i]);power.push(...values.slice(1));});compareSpectrogram({...calculateSpectrogram(raw,'x'),power:Float64Array.from(power)},reference);
  for(const args of [['-a','bad'],['-f','1e999'],['-s','-f','1e999'],['-r','-s']]){const result=spawnSync(process.execPath,[cli,'-o',csv,...args,input],{env,encoding:'utf8'});assert.equal(result.status,1);assert.match(result.stderr,/Invalid|requires/);assert.equal((await readFile(csv,'utf8')).trim().split('\n').length,rows.length);}
  assert.equal(await readFile(input,'utf8'),text);
 }finally{await rm(dir,{recursive:true,force:true});}
});
