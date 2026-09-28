import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DeltaCalibration,fitDeltaCalibration,type DeltaCalibrationInput} from '../src/calibration/delta-calibration.ts';
import type {Vec3} from '../src/math/mathutil.ts';
import assert from 'node:assert/strict';
const geometry={radius:100,angles:[210,330,90] as Vec3,arms:[250,251,250.5] as Vec3,endstops:[300,300.2,299.9] as Vec3,stepDistances:[.0125,.00625,.0125] as Vec3},original=new DeltaCalibration(geometry),truth=new DeltaCalibration({...geometry,radius:100.2,endstops:[300.1,300.1,300.1]});
const points=Array.from({length:7},(_,i)=>{const angle=i*Math.PI/3;return original.stable(i?[Math.cos(angle)*65,Math.sin(angle)*65,0]:[0,0,0]);}),probes=points.map(stable=>({stable,height:truth.position(stable)[2]}));
const distances=Array.from({length:12},(_,i)=>{const first=points[1+i%6],second=points[1+(i+2)%6],a=truth.position(first),b=truth.position(second);return {first,second,distance:Math.sqrt((a[0]-b[0])**2+(a[1]-b[1])**2+(a[2]-b[2])**2)};});
const cases:DeltaCalibrationInput[]=[{geometry,probes},{geometry,probes,distances}];
const python=String.raw`
import ast,sys,json,math,logging,time,pathlib,types,collections
root=pathlib.Path(sys.argv[1]);sys.path.insert(0,str(root));import mathutil
for file,name in [('kinematics/delta.py','DeltaCalibration'),('extras/delta_calibrate.py','DeltaCalibrate')]:
 text=(root/file).read_text();node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name==name);exec(ast.get_source_segment(text,node),globals())
MEASURE_WEIGHT=.5
mathutil.background_coordinate_descent=lambda printer,adj,params,error:mathutil.coordinate_descent(adj,params,error)
results=[]
for case_index,data in enumerate(json.load(open(sys.argv[2]))):
 print('Python Delta case',case_index,flush=True,file=sys.stderr)
 g=data['geometry'];original=DeltaCalibration(g['radius'],g['angles'],g['arms'],g['endstops'],g['stepDistances']);owner=DeltaCalibrate.__new__(DeltaCalibrate)
 owner.printer=types.SimpleNamespace(lookup_object=lambda name:types.SimpleNamespace(get_kinematics=lambda:types.SimpleNamespace(get_calibration=lambda:original)))
 owner.manual_heights=[];owner.gcode=types.SimpleNamespace(respond_info=lambda text:None)
 saved=[];owner.save_state=lambda p,d,c:saved.append(c)
 probes=[(p['height'],p['stable']) for p in data['probes']];distances=[(p['distance'],p['first'],p['second']) for p in data.get('distances',[])]
 samples=[]
 for run in range(1):
  start=time.perf_counter();owner.calculate_params(probes,distances)
  samples.append((time.perf_counter()-start)*1000)
 c=saved[-1];results.append({'geometry':{'radius':c.radius,'angles':c.angles,'arms':c.arms,'endstops':c.endstops,'stepDistances':c.stepdists},'positions':[c.get_position_from_stable(p['stable']) for p in data['probes']],'samplesMs':samples})
print(json.dumps(results))
`;
const dir=mkdtempSync(join(tmpdir(),'delta-calibration-oracle-')),inputPath=join(dir,'input.json');writeFileSync(inputPath,JSON.stringify(cases));
const ref=spawnSync('python3',['-c',python,fileURLToPath(new URL('../../klippy',import.meta.url)),inputPath],{encoding:'utf8',stdio:['pipe','pipe','inherit'],timeout:60000,maxBuffer:1024*1024});rmSync(dir,{recursive:true,force:true});assert.equal(ref.status,0,String(ref.error??ref.stderr));const references=JSON.parse(ref.stdout);
const results=[];
for(const [index,input] of cases.entries()){
 const samples:number[]=[];let result!:ReturnType<typeof fitDeltaCalibration>;
 for(let run=0;run<1;run++){const start=performance.now();result=fitDeltaCalibration(input);samples.push(performance.now()-start);}
 const oracle=references[index],cal=new DeltaCalibration(result.geometry);let maxPositionError=0,maxParameterError=0;
 for(const key of ['radius','angles','arms','endstops','stepDistances'] as const){const a=[result.geometry[key]].flat(),b=[oracle.geometry[key]].flat();a.forEach((v,i)=>maxParameterError=Math.max(maxParameterError,Math.abs(v-b[i])));}
 for(const [i,p] of input.probes.entries())cal.position(p.stable).forEach((v,j)=>maxPositionError=Math.max(maxPositionError,Math.abs(v-oracle.positions[i][j])));

 const median=(a:number[])=>[...a].sort((a,b)=>a-b)[0],nodeMs=median(samples),pythonMs=median(oracle.samplesMs);
 results.push({extended:index===1,nodeMs,pythonMs,speedup:pythonMs/nodeMs,maxPositionError,maxParameterError,finalError:result.finalError,geometry:result.geometry,pythonGeometry:oracle.geometry,passed:maxPositionError<1e-5&&maxParameterError<1e-4&&result.finalError<1e-8,nodeSamplesMs:samples,pythonSamplesMs:oracle.samplesMs});
}
console.log(JSON.stringify({node:process.version,warmups:0,samples:1,results,scope:'Original Python DeltaCalibration and DeltaCalibrate.calculate_params vs TS kernel on asymmetric three-tower geometry, seven heights, with/without twelve distance constraints. Excludes worker startup, probe IO, persistence and physical accuracy.'},null,2));

assert(results.every(r=>r.passed),'Delta calibration oracle precision gate failed; inspect emitted evidence');
