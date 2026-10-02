import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {Thermistor,type ThermistorModel} from '../src/thermal/thermistor.ts';
const configs:{inline:number;model:ThermistorModel}[]=[{inline:0,model:{point:[25,100000],beta:3950}},{inline:0,model:{points:[[20,126800],[150,1360],[300,80.65]]}},{inline:100,model:{points:[[25,100000],[150,1641.9],[250,226.15]]}}];
const samples=Array.from({length:20000},(_,i)=>[.03+.95*i/20000,300*i/20000]);
const python=String.raw`
import sys,json,ast,math,time,logging
logging.disable(logging.CRITICAL);text=open(sys.argv[1]).read();node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name=='Thermistor');exec(ast.get_source_segment(text,node),globals());KELVIN_TO_CELSIUS=-273.15;data=json.load(open(sys.argv[2]))
converters=[]
for config in data['configs']:
 t=Thermistor(4700.,config['inline']);m=config['model']
 if 'beta' in m:t.setup_coefficients_beta(*m['point'],m['beta'])
 else:t.setup_coefficients(*[v for p in m['points'] for v in p])
 converters.append(t)
def run(t):return [[t.calc_temp(adc),t.calc_adc(temp)] for adc,temp in data['samples']]
results=[run(t) for t in converters];times=[]
for t in converters:
 for _ in range(3):run(t)
 values=[]
 for _ in range(11):
  start=time.perf_counter();run(t);values.append((time.perf_counter()-start)*1000)
 times.append(sorted(values))
print(json.dumps({'results':results,'coefficients':[[t.c1,t.c2,t.c3] for t in converters],'times':times}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-thermistor-'));let oracle:{results:number[][][];coefficients:number[][];times:number[][]};
try{const path=join(dir,'input.json');writeFileSync(path,JSON.stringify({samples,configs}));const p=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/extras/thermistor.py',import.meta.url)),path],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});if(p.status!==0)throw new Error(p.stderr||String(p.error));oracle=JSON.parse(p.stdout);}finally{rmSync(dir,{recursive:true,force:true});}
let maxTemperatureError=0,maxADCError=0;const timings=[];
for(const [index,c] of configs.entries()) {
 const t=new Thermistor(4700,c.inline,c.model),run=()=>samples.map(([adc,temp])=>[t.temperature(adc),t.adc(temp)]),actual=run();
 actual.forEach((row,i)=>{maxTemperatureError=Math.max(maxTemperatureError,Math.abs(row[0]-oracle.results[index][i][0]));maxADCError=Math.max(maxADCError,Math.abs(row[1]-oracle.results[index][i][1]));});
 assert.ok(maxTemperatureError<1e-8);assert.ok(maxADCError<1e-12);
 for(let i=0;i<3;i++)run();const times=[];for(let i=0;i<11;i++){const start=performance.now();run();times.push(performance.now()-start);}times.sort((a,b)=>a-b);
 timings.push({model:index,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:oracle.times[index][5],pythonP95Ms:oracle.times[index][10],speedup:oracle.times[index][5]/times[5]});assert.ok(times[5]<=oracle.times[index][5],'Thermistor conversion regressed');
}
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,conversions:120000,maxTemperatureError,maxADCError,timings},null,2));
