import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {ShaperSimulationOptions} from '../src/diagnostics/graph-shaper.ts';
const source=String.raw`
import sys,types,runpy,json,time
sys.modules['matplotlib']=types.ModuleType('matplotlib')
r=runpy.run_path(sys.argv[1]);request=json.load(sys.stdin);outputs=[]
for options in request['cases']:
 def run():
  hz=options.get('frequency',50);dr=options.get('damping',.1);tests=options.get('testDamping',[.075,.1,.15])
  shaper=r['shaper_defs'].init_shaper(options.get('shaper','mzv').lower(),hz,dr);r['shift_pulses'](shaper)
  freqs,response,legend=r['gen_shaper_response'](shaper,hz,tests)
  times,step,step_legend=r['gen_shaped_step_function'](shaper,hz,options.get('systemFrequency',60),options.get('systemDamping',.15))
  return dict(freqs=freqs,response=response,times=times,step=step)
 timings=[]
 for i in range(request['runs']):
  start=time.perf_counter();result=run();timings.append((time.perf_counter()-start)*1000)
 outputs.append(dict(result=result,timings=timings))
print(json.dumps(outputs,allow_nan=False))
`;
export interface ReferenceResult {result:{freqs:number[];response:number[][];times:number[];step:number[][]};timings:number[];}
export function shaperGraphReference(cases:ShaperSimulationOptions[],runs=1):ReferenceResult[]{return JSON.parse(execFileSync('/usr/bin/python3',['-c',source,fileURLToPath(new URL('../../scripts/graph_shaper.py',import.meta.url))],{input:JSON.stringify({cases,runs}),encoding:'utf8',maxBuffer:64*1024**2}));}
