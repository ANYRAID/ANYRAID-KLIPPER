import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {motanCsvChunks,writeMotanCsv} from '../src/motan/csv-export.ts';
import type {MotanAnalysis} from '../src/motan/analyzer.ts';
import {managerFixture} from './helpers/motan-manager-fixture.ts';
import {scipyReferenceEnvironment} from './helpers/motan-sos-oracle.ts';
const root=fileURLToPath(new URL('../../',import.meta.url)),cli=join(root,'scripts/motan/data_export.ts');
const collect=async(analysis:MotanAnalysis,columns:string[])=>{const chunks=[];for await(const chunk of motanCsvChunks(analysis,columns))chunks.push(chunk);return Buffer.concat(chunks).toString();};
function fixture(count=7):MotanAnalysis{
 const numbers=[-0,Number.MIN_VALUE,Number.MAX_VALUE,1e-7,1e21,1.2345678901234567,-5];
 return {times:Float64Array.from({length:count},(_,i)=>i/8),datasets:{a:Float64Array.from({length:count},(_,i)=>numbers[i%7])},labels:{a:{name:'a',label:'quoted, "sensor"\nline',units:'Velocity\n(mm/s)'}}};
}
test('Motan CSV preserves numeric round trips, quoted headers and duplicate column order',async()=>{
 const analysis=fixture(),csv=await collect(analysis,['a','a']);
 assert.ok(csv.startsWith('Time (s),"quoted, ""sensor""\nline (mm/s)",'));
 assert.ok(csv.endsWith('\r\n'));assert.ok(csv.includes('\r\n0,-0,-0\r\n'));
 const parsed=JSON.parse(execFileSync('python3',['-c',`import csv,sys,io,json,struct
rows=list(csv.reader(io.StringIO(sys.stdin.read(),newline='')))
print(json.dumps(dict(header=rows[0],bits=[[struct.pack('>d',float(v)).hex() for v in row] for row in rows[1:]])))`],{input:csv,encoding:'utf8'}));
 assert.deepEqual(parsed.header,['Time (s)',analysis.labels.a.label+' (mm/s)',analysis.labels.a.label+' (mm/s)']);
 const bits=(n:number)=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex');};
 assert.deepEqual(parsed.bits,Array.from(analysis.times,(t,i)=>[bits(t),bits(analysis.datasets.a[i]),bits(analysis.datasets.a[i])]));
 const empty=fixture(0);empty.labels.a.units='Unknown';assert.equal(await collect(empty,['a']),'Time (s),"quoted, ""sensor""\nline"\r\n');
});
test('Motan CSV atomic output preserves prior files on failure and cancellation, removes temporary files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-csv-')),output=join(dir,'export.csv');
 try{
  await writeFile(output,'previous');
  await assert.rejects(writeMotanCsv(fixture(),['a'],output,{maxOutputBytes:10}),/output limit/);
  assert.equal(await readFile(output,'utf8'),'previous');
  const malformed=fixture();malformed.datasets.a[6]=NaN;
  await assert.rejects(writeMotanCsv(malformed,['a'],output),/finite/);
  await assert.rejects(writeMotanCsv(fixture(),['missing'],output),/column/);
  const controller=new AbortController(),reason=new Error('stop export');
  const pending=writeMotanCsv(fixture(100000),['a'],output,{signal:controller.signal});
  setTimeout(()=>controller.abort(reason),5);await assert.rejects(pending);
  assert.equal(await readFile(output,'utf8'),'previous');assert.deepEqual(await readdir(dir),['export.csv']);
  const pre=new AbortController();pre.abort(reason);await assert.rejects(writeMotanCsv(fixture(),['a'],output,{signal:pre.signal}),error=>error===reason);
  await writeMotanCsv(fixture(),['a'],output);assert.equal(await readFile(output,'utf8'),await collect(fixture(),['a']));
  assert.deepEqual(await readdir(dir),['export.csv']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('Motan numeric CSV CLI matches original exporter values and runs without Python',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'motan-csv-cli-')),prefix=join(dir,'log'),output=join(dir,'out.csv');
 try{
  await managerFixture(prefix);
  const columns=['trapq(toolhead,x)','derivative(trapq(toolhead,x))','status(heater.temperature)','trapq(toolhead,x)'];
  const args=[cli,prefix,'-c',JSON.stringify(columns),'-d','.2','--segment-time','.01'];
  const env={...process.env,PATH:'/no-external-programs'};
  const stdout=execFileSync(process.execPath,args,{encoding:'utf8',env,timeout:10000});
  execFileSync(process.execPath,[...args,'-o',output],{env,timeout:10000});
  assert.equal(await readFile(output,'utf8'),stdout);
  const legacy=execFileSync('python3',[join(root,'scripts/motan/data_export.py'),prefix,'-c',JSON.stringify(columns),'-d','.2','--segment-time','.01'],{encoding:'utf8',env:scipyReferenceEnvironment(),timeout:15000});
  const decoded=JSON.parse(execFileSync('python3',['-c',`import sys,csv,io,json
x=json.load(sys.stdin)
def decode(s):
 rows=list(csv.reader(io.StringIO(s,newline='')))
 return [rows[0],[[float(v) for v in row] for row in rows[1:]]]
print(json.dumps([decode(s) for s in x]))`],{input:JSON.stringify([legacy,stdout]),encoding:'utf8'}));
  assert.deepEqual(decoded[1],decoded[0]);
  await writeFile(output,'keep');
  assert.throws(()=>execFileSync(process.execPath,[cli,prefix,'-o',output,'-c',"__import__('os').system('false')"],{env,stdio:'pipe'}));
  assert.throws(()=>execFileSync(process.execPath,[cli,prefix,'-o',output,'-c',"['status(configfile.settings.printer.kinematics)']",'-d','.01'],{env,stdio:'pipe'}),/cannot represent/);
  assert.equal(await readFile(output,'utf8'),'keep');
  assert.throws(()=>execFileSync(process.execPath,[...args,'-s','Infinity'],{env,stdio:'pipe'}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
