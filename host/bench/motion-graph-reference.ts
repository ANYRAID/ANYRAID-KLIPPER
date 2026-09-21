import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const source=String.raw`
import sys,types,runpy,json,time
panels=[]
class Stub:
 def __getattr__(self,n): return lambda *a,**k:None
class Axis(Stub):
 def __init__(self):self.panel={'curves':[]};panels.append(self.panel)
 def plot(self,x,y,*a,**kw):self.panel['curves'].append(dict(times=x,values=y))
 def set_ylim(self,v):self.panel['range']=v
 def set_ylabel(self,v):self.panel['axis']=v
def subplots(**kw):
 panels.clear();return Stub(),[Axis() for _ in range(kw['nrows'])]
m=types.ModuleType('matplotlib');m.pyplot=types.SimpleNamespace(subplots=subplots);m.font_manager=types.SimpleNamespace(FontProperties=Stub);sys.modules['matplotlib']=m
r=runpy.run_path(sys.argv[1]);samples=[]
for i in range(int(sys.argv[2])):
 start=time.perf_counter();r['plot_motion']();samples.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(panels=panels,samples=samples),allow_nan=False))
`;
export function motionGraphReference(runs=1):{panels:{curves:{times:number[];values:number[]}[];axis:string;range?:[number,number]}[];samples:number[]}{return JSON.parse(execFileSync('/usr/bin/python3',['-c',source,fileURLToPath(new URL('../../scripts/graph_motion.py',import.meta.url)),String(runs)],{encoding:'utf8',maxBuffer:32*1024**2}));}
