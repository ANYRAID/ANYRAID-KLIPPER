import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {parsePrusaMetadata,type PrusaFamily} from '../src/moonraker/metadata-prusa.ts';
import {roundMetadataHeight,metadataSum} from '../src/moonraker/metadata-values.ts';
const source=process.env.MOONRAKER_METADATA_SOURCE;if(!source)throw new Error('Set MOONRAKER_METADATA_SOURCE');
assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),'ae2488ff23e6ddcaf961b063506dad1a7141b38b92102bc174422ed244641d2e');
const all=`; layer_height = 0.15
; first_layer_height = 150%
; filament used [mm] = 10000000000000000,1,1
; filament used [g] = 1.5,2.5
; total filament used [g] = 4
; filament_type = "PLA, Silk";"中😀";" P\\"ETG "
; filament_settings_id = "A; B";C
; filament_colour = #ff0000;#00ff00
; extruder_colour = #ffffff
; temperature = ２００; +210;2_20
; referenced_tools = 0;1
; single_extruder_multi_material = 1
; total layers count = 100
; total toolchanges = 0
; total filament change = 5
; estimated printing time (normal mode) = ١d 2h 3m 4s
; first_layer_temperature = 205
; first_layer_bed_temperature = 60
; chamber_temperature = 40
; nozzle_diameter = 0.4
; printer_vendor = "ANYRAID"
; printer_model = "A1"
; printer_variant = "0.4"
; profile_version = "v1"
;BEFORE_LAYER_CHANGE
;١٢.٥
;BEFORE_LAYER_CHANGE
;note
;13.
G1 Z100 F1200
; initial_layer_print_height = 0.3
; max_z_height: 20
; total filament length [mm] : 500
; total filament weight [g] : 2.5
; nozzle_temperature_initial_layer = 220
; hot_plate_temp_initial_layer = 65
; chamber_temperatures = 42
; total layer number: 80
; filament used = 12.5mm
; filament_length_m = 1.25
; filament mass_g = 4.5
`;
const inputs=['',all,'; first_layer_height = 150%\n',all.replace('; temperature = ２００; +210;2_20','; temperature = 200;broken'),'; filament_type = ""; ;A\n; filament_settings_id = "a\\"b"; " 😀 "\n; temperature = 1__2\n; referenced_tools = -1;٢\n','; estimated printing time = unknown\n; total filament change = 3\n; printer_vendor = ""\n','; layer_height = .333333\n; first_layer_height = 123.45%\nG1 Z.25 F100\nG1 Z1.25 F100\n'];
const families:PrusaFamily[]=['PrusaSlicer','Slic3rPE','Slic3r','BambuStudio'];
const fixtures=families.flatMap(family=>inputs.flatMap(text=>[{family,header:text,footer:'',size:Buffer.byteLength(text)},{family,header:'',footer:text,size:Buffer.byteLength(text)},{family,header:text,footer:text,size:Buffer.byteLength(text)*2}]));
const rounds=[0,-0,0.0000005,0.0000015,0.0000025,-0.0000005,1e-308,1e100];let seed=42;for(let i=0;i<1000;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;rounds.push((seed%10000000)/10000000);}
const sums=[[1e16,1,1],[.1,.2,.3],[1e16,1,-1e16],Array.from({length:1000},()=>0.1)];
const benchmark={family:'PrusaSlicer' as const,header:';header\n',footer:'; no metadata here\n'.repeat(40000)+all,size:800000};
const benchmarks=families.map(family=>({...benchmark,family,...(family==='BambuStudio'?{header:benchmark.footer,footer:';footer\n'}:{})}));
const python=String.raw`
import ast,re,json,sys,time,logging
from typing import *
r=json.load(sys.stdin);m=ast.parse(open(r['source']).read());READ_SIZE=1024**2
exec('from __future__ import annotations\n'+ast.unparse(ast.Module(body=[n for n in m.body if isinstance(n,(ast.ClassDef,ast.FunctionDef))],type_ignores=[])),globals())
def parse(f):
 obj=globals()[f['family']]('',f['size'],'');obj.header_data=f['header'];obj.footer_data=f['footer'];result={}
 for name in vars(BaseSlicer):
  if name.startswith('parse_') and name!='parse_thumbnails':
   value=getattr(obj,name)()
   if value is not None:result[name[6:]]=value
 return result
results=[parse(f) for f in r['fixtures']];samples=[[] for _ in r['benchmarks']]
for i in range(16):
 for j,b in enumerate(r['benchmarks']):
  t=time.perf_counter();parse(b);elapsed=(time.perf_counter()-t)*1000
  if i>=5:samples[j].append(elapsed)
print(json.dumps(dict(results=results,rounds=[round(v,6) for v in r['rounds']],sums=[sum(v) for v in r['sums']],samples=samples,python=sys.version.split()[0])))
`;
const child=spawnSync('/usr/bin/python3',['-c',python],{input:JSON.stringify({source,fixtures,rounds,sums,benchmarks}),encoding:'utf8',maxBuffer:8*1024**2,timeout:60000});if(child.status!==0)throw new Error(child.stderr);const oracle=JSON.parse(child.stdout);
fixtures.forEach((f,i)=>assert.deepEqual(parsePrusaMetadata(f,f.family),oracle.results[i],`fixture ${i} ${f.family}`));
rounds.forEach((v,i)=>assert.ok(roundMetadataHeight(v)===oracle.rounds[i],`round ${v}`));assert.deepEqual(sums.map(metadataSum),oracle.sums);
const samples:number[][]=families.map(()=>[]);for(let i=0;i<16;i++)for(const [j,b] of benchmarks.entries()){const begin=performance.now();parsePrusaMetadata(b,b.family);if(i>=5)samples[j].push(performance.now()-begin);}
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};};
console.log(JSON.stringify({node:process.version,python:oracle.python,fieldFixtures:fixtures.length,roundFixtures:rounds.length,sumFixtures:sums.length,warmups:5,runs:11,parseBytes:Buffer.byteLength(benchmark.header+benchmark.footer),families,nodeResult:samples.map(stats),pythonResult:oracle.samples.map(stats),scope:'Pinned four Prusa-family non-image parse methods, header/footer supplied directly. No IO, thumbnails, Workers, or printer deadlines.'},null,2));
