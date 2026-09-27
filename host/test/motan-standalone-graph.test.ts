import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {buildMotan} from '../scripts/build-motan.ts';
import {managerFixture} from './helpers/motan-manager-fixture.ts';
import sharp from 'sharp';
// Outside the repository: ancestor node_modules cannot mask missing packaging.
test('standalone compiled Motan graphs and CSV run with independently installed locked dependencies',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-standalone-')),output=join(dir,'app'),prefix=join(dir,'capture');
 const env={...process.env,PATH:'/no-programs',NODE_OPTIONS:'--no-experimental-strip-types',NODE_PATH:'',NODE_DISABLE_COMPILE_CACHE:'1'};
 try{
  await buildMotan(output);const marker=JSON.parse(await readFile(join(output,'build-info.json'),'utf8'));
  for(const file of ['scripts/motan/motan_graph.js','host/assets/fonts/DejaVuSans.ttf','package-lock.json'])assert(marker.files[file],file);
  execFileSync(process.execPath,[join(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js'),'ci','--omit=dev','--include=optional','--ignore-scripts','--no-audit','--no-fund'],{cwd:output,env,timeout:120000,maxBuffer:2*1024**2});
  await managerFixture(prefix,2,'cartesian');const original=await readFile(prefix+'.json.gz'),durations:Record<string,number>={};
  for(const format of ['json','svg','png','html','pdf']){
   const target=join(dir,'graph.'+format),begin=performance.now();
   execFileSync(process.execPath,[join(output,'scripts/motan/motan_graph.js'),prefix,'-g',JSON.stringify([['trapq(toolhead,velocity)?marker=s&fillstyle=left&mfc=red&mfcalt=blue'],['trapq(toolhead,accel)?marker=%2B'],['deviation(stepq(stepper_x),kin(stepper_x))?marker=X']]),'-d','.2','--segment-time','.01','-o',target],{cwd:'/',env,timeout:15000});durations[format]=performance.now()-begin;
   const bytes=await readFile(target);assert(bytes.length>100);
   if(format==='json'){const panels=JSON.parse(bytes.toString());assert.equal(panels.length,3);assert(panels.every((p:any)=>p.curves[0].values.length>0));}
   if(format==='svg')assert.match(bytes.toString(),/Motion Analysis/);
   if(format==='png'){const info=await sharp(bytes).metadata();assert.equal(info.width,800);assert.equal(info.height,1800);}
   if(format==='html')assert.match(bytes.toString(),/Content-Security-Policy/);
   if(format==='pdf')assert.equal(bytes.subarray(0,4).toString(),'%PDF');
  }
  const csv=execFileSync(process.execPath,[join(output,'scripts/motan/data_export.js'),prefix,'-c','["trapq(toolhead,x)"]','-d','.2','--segment-time','.01'],{cwd:'/',env,encoding:'utf8',timeout:15000});assert.match(csv,/^Time \(s\),toolhead x position \(mm\)\r\n/);
  assert.deepEqual(await readFile(prefix+'.json.gz'),original);t.diagnostic(JSON.stringify({standalone:true,node:process.version,coldExportMs:durations,scope:'one cold child per format; independent package outside repository; no Python or TS loader'}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
