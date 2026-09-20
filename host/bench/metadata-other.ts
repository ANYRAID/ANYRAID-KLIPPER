import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {parseOtherMetadata,type OtherFamily} from '../src/moonraker/metadata-other.ts';
import {detectSlicerObjects} from '../src/moonraker/metadata-fields.ts';
import {roundMetadataDecimal} from '../src/moonraker/metadata-values.ts';
const source=process.env.MOONRAKER_METADATA_SOURCE;if(!source)throw new Error('Set MOONRAKER_METADATA_SOURCE');assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),'ae2488ff23e6ddcaf961b063506dad1a7141b38b92102bc174422ed244641d2e');
const all=`;MINZ:0.2
;Layer height: 0.15
;MAXZ:20
;Filament used: 1.25m, 2.5m
;Filament weight = [1.5, 2.5]
;Filament type = PLA
;Filament name = "中😀"
;TIME:100
;TIME:120
M109 S205
M109 T0 S215
M190 S60
M191 S40
;LAYER_COUNT:100
;Nozzle diameter = 0.4
G1 Z.15 F1200
G1 Z10 F1200
; layerHeight,0.25
; nozzleDiameter,0.6
; Material Length: 120 mm
; Material Weight: 2.5 g
; printMaterial,"Silk"
; makerBotModelMaterial,PLA
; Build Time: 1 hour 2 min 3 sec
; temperatureName,Extruder 1,Heated Bed
; temperatureSetpointTemperatures,２.１e2,+6_0
; temperatureController,tool
; temperatureType,extruder
; temperatureSetpoints,1|220
; temperatureController,bed
; temperatureType,platform
; temperatureSetpoints,1|65
; first_layer_thickness_mm = .3
; max_layer_thickness_mm = .2
; END_LAYER_OBJECT z=15.25
; Ext #0 = 100 mm
; Ext #1 = 200 mm
; Calculated Build Time: 1.2345 minutes
; first_layer_C = 210
; bed_C = 60
; chamber_C = 40
;LAYER:0
;HEIGHT:.2
;LAYER:1
;HEIGHT:.15
;Bounding Box: 0 1 2 3 4 25.5
;Material#0 Used: 1000
;Filament Diameter #0: 1.75
;Filament Density #0: 1240
;Filament Type #0: PLA+
;Filament Name #0: Name
;Print Time: 100.5
;Dimension: 1.0 2.0 3.0 0.4
; z_layer_height_first_layer_mm : .2
; z_layer_height_mm : .15
; print_height_mm : 20.25
; extruder_temp_degree_c_0 : 210
; bed_temp_degree_c : 60
; chamber_temp_degree_c : 40
; filament_used_mm : 1200
; filament_used_g : 4.5
; filament_name : Ice
; filament_type : ABS
; estimated_print_time_s : 150
; layer_count : 100
; nozzle_diameter_mm_0 : .4
; firstSliceHeight = .2
; sliceHeight = .15
; firstLayerNozzleTemp = 210
; firstLayerBedTemp = 60
; --- filament used: 1200 mm
; --- print time: 200s
;; --- layer 8 (last)
;; --- layer 3 (lower)
G1 Z12.5 ; z-hop end
`;
const variants:[OtherFamily,string][]=[['Cura','5'],['Simplify3D','4.1'],['Simplify3D','5.2'],['KISSlicer','2'],['IdeaMaker','5'],['IceSL','2'],['KiriMoto','3']];
const inputs=['',all,all.replaceAll('\n','\r\n'),'; temperatureName,Extruder 1,Heated Bed\n; temperatureSetpointTemperatures,broken,60\n','; Build time: unknown\n; Calculated Build Time: 0.00025 minutes\n;Filament name = ""\n',';Material\u20280 Used: 1200\n;Filament Diameter #0: 1.75\n;Filament Density #0: 1240\n;; --- layer ٢ (x)\n'];
const fixtures=variants.flatMap(([family,version])=>inputs.flatMap(text=>[{family,version,header:text,footer:'',size:Buffer.byteLength(text)},{family,version,header:'',footer:text,size:Buffer.byteLength(text)},{family,version,header:text,footer:text,size:Buffer.byteLength(text)*2}]));
let seed=17;for(let i=0;i<200;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const diameter=(seed%30000)/10000;fixtures.push({family:'IdeaMaker',version:'5',header:`;Filament Diameter #0: ${diameter}\n;Filament Density #0: 1240\n`,footer:';Material#0 Used: 1234.5\n',size:100});}
const benchmarks=variants.map(([family,version])=>({family,version,header:'; no metadata\n'.repeat(20000)+all,footer:'; no metadata\n'.repeat(20000)+all,size:600000}));
const rounds=[2.675,1.005,-2.675,0.015,0.025,0.005,...Array.from({length:1000},(_,i)=>i/1000)];
const objectFixtures=variants.flatMap(([family])=>['','M486 S0','\nM486 S0','\n;MESH:part','\n;PRINTING:one','\n; printing object a','\nM486 S0\nEXCLUDE_OBJECT_DEFINE NAME=a','\nDEFINE_OBJECT NAME=a\n;MESH:x'].map(header=>({family,header})));
const python=String.raw`
import ast,re,json,sys,time,logging,os
logger=logging.getLogger("metadata")
from typing import *
r=json.load(sys.stdin);m=ast.parse(open(r['source']).read());READ_SIZE=1024**2
exec('from __future__ import annotations\n'+ast.unparse(ast.Module(body=[n for n in m.body if isinstance(n,(ast.ClassDef,ast.FunctionDef))],type_ignores=[])),globals())
def parse(f):
 obj=globals()[f['family']]('',f['size'],'',f['family'],f['version']);obj.header_data=f['header'];obj.footer_data=f['footer'];result={}
 for name in vars(BaseSlicer):
  if name.startswith('parse_') and name!='parse_thumbnails':
   value=getattr(obj,name)()
   if value is not None:result[name[6:]]=value
 return result
objects=[]
for f in r['objectFixtures']:
 obj=globals()[f['family']]('',len(f['header'].encode()),f['header']);objects.append(dict(hasObjects=obj.has_objects(),hasM486Objects=obj.has_m486_objects))
results=[parse(f) for f in r['fixtures']];samples=[[] for _ in r['benchmarks']]
for i in range(16):
 for j,b in enumerate(r['benchmarks']):
  t=time.perf_counter();parse(b);elapsed=(time.perf_counter()-t)*1000
  if i>=5:samples[j].append(elapsed)
print(json.dumps(dict(results=results,objects=objects,rounds=[round(v,2) for v in r['rounds']],samples=samples,python=sys.version.split()[0])))
`;
const child=spawnSync('/usr/bin/python3',['-c',python],{input:JSON.stringify({source,fixtures,benchmarks,rounds,objectFixtures}),encoding:'utf8',maxBuffer:16*1024**2,timeout:60000});if(child.status!==0)throw new Error(child.stderr);const oracle=JSON.parse(child.stdout);
let maxWeightUlp=0,maxWeightAbsolute=0;const bits=(v:number)=>{const a=new ArrayBuffer(8),d=new DataView(a);d.setFloat64(0,v);return d.getBigUint64(0);};
fixtures.forEach((f,i)=>{const actual=parseOtherMetadata(f,f.family,f.version),expected=oracle.results[i];if(f.family==='IdeaMaker'&&typeof actual.filament_weight_total==='number'&&typeof expected.filament_weight_total==='number'){const delta=bits(actual.filament_weight_total)-bits(expected.filament_weight_total),ulp=Number(delta<0n?-delta:delta);assert.ok(ulp<=4,`weight ULP ${ulp}`);maxWeightUlp=Math.max(maxWeightUlp,ulp);maxWeightAbsolute=Math.max(maxWeightAbsolute,Math.abs(actual.filament_weight_total-expected.filament_weight_total));delete actual.filament_weight_total;delete expected.filament_weight_total;}assert.deepEqual(actual,expected,`fixture ${i} ${f.family} ${f.version}`);});rounds.forEach((v,i)=>assert.ok(roundMetadataDecimal(v,2)===oracle.rounds[i]));
assert.deepEqual(objectFixtures.map(f=>detectSlicerObjects(f.header,f.family)),oracle.objects);
const samples:number[][]=variants.map(()=>[]);for(let i=0;i<16;i++)for(const [j,b] of benchmarks.entries()){const begin=performance.now();parseOtherMetadata(b,b.family,b.version);if(i>=5)samples[j].push(performance.now()-begin);}
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};};
console.log(JSON.stringify({node:process.version,python:oracle.python,fieldFixtures:fixtures.length,objectFixtures:objectFixtures.length,maxWeightUlp,maxWeightAbsolute,roundFixtures:rounds.length,warmups:5,runs:11,variants,parseBytes:Buffer.byteLength(benchmarks[0].header+benchmarks[0].footer),nodeResult:samples.map(stats),pythonResult:oracle.samples.map(stats),scope:'Remaining six fixed upstream non-image families, Simplify3D v4/v5 separately. In-memory parsing; no IO/images/Worker or physical print timing.'},null,2));
