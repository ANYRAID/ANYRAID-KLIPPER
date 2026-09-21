import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {StatsPlot} from '../src/diagnostics/graphstats.ts';
const source=String.raw`
import sys,types,runpy,json,time
state={}
class Stub:
 def __getattr__(self,n): return lambda *a,**k:None
class Axis(Stub):
 def set_title(self,v): state['title']=v
 def set_ylabel(self,v): state['axes']=[v]
 def plot(self,t,v,*a,**kw):
  state['curves'].append(dict(label=kw['label'],axis=0,style='line',times=t.copy(),values=v.copy()));return [None]
def subplots(**kw):
 state.clear();state.update(curves=[]);return Stub(),Axis()
m=types.ModuleType('matplotlib');m.pyplot=types.SimpleNamespace(subplots=subplots);m.font_manager=types.SimpleNamespace(FontProperties=Stub);sys.modules['matplotlib']=m
r=runpy.run_path(sys.argv[1]);runs=int(sys.argv[2]);samples=[]
for i in range(runs):
 start=time.perf_counter();r['plot_motion']();samples.append((time.perf_counter()-start)*1000)
p=r['gen_positions']();raw=r['calc_pa_raw'](p)
print(json.dumps(dict(plot=state,positions=p,raw=raw,smooth=r['calc_pa'](p),samples=samples),allow_nan=False))
`;
export function extruderReference(runs=1):{plot:StatsPlot;positions:number[];raw:number[];smooth:number[];samples:number[]}{return JSON.parse(execFileSync('/usr/bin/python3',['-c',source,fileURLToPath(new URL('../../scripts/graph_extruder.py',import.meta.url)),String(runs)],{encoding:'utf8',maxBuffer:32*1024**2}));}
