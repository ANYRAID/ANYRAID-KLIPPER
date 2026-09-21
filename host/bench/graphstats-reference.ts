import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export function graphstatsFixture(count:number):string{const lines=['unrelated log'];for(let i=0;i<count;i++){const time=1700000000+i+(i%17===0?-.25:0),bytes=i<30?i*137:(i-30)*123;lines.push(`${i%2?'INFO:root:Stats':'Stats'} ${time}: mcu: mcu_awake=0.03 mcu_task_avg=0.0002 mcu_task_stddev=0.00003 bytes_write=${bytes} bytes_retransmit=${i*3} freq=${16000000+i%13} adj=${16000000-i%7} tool: mcu_awake=0.01 mcu_task_avg=0.0001 mcu_task_stddev=0.00002 bytes_write=${i*91} bytes_retransmit=0 freq=${12000000+i%5} adj=12000000 heater: temp=${20+i%240} target=${i%3?200:0} pwm=${i%2?.5:0} print_time=${i} buffer_time=${(i%10)/10} print_stall=${i<40?'9007199254740992':'9007199254740993'} cputime=${i*.31} sysload=0.2 memavail=${100000-i}`);}return lines.join('\n');}
const source=String.raw`
import sys, types, runpy, tempfile, json, datetime, time, io
state={}
class Stub:
 def __getattr__(self, name): return lambda *a,**k: None
class Axis(Stub):
 def __init__(self, index): self.index=index; self.xaxis=self.yaxis=Stub()
 def set_title(self, value): state['title']=value
 def set_ylabel(self, value): state['axes'][self.index]=value
 def twinx(self): state['axes'].append(''); return Axis(1)
 def plot_date(self,times,values,style,**kw): state['curves'].append(dict(label=kw['label'],axis=self.index,style='points' if style=='.' else 'line',times=[t.replace(tzinfo=datetime.timezone.utc).timestamp() for t in times],values=list(values)))
 def get_legend_handles_labels(self): return [],[]
def subplots():
 state.clear(); state.update(title='',axes=[''],curves=[]); return Stub(),Axis(0)
module=types.ModuleType('matplotlib');module.pyplot=types.SimpleNamespace(subplots=subplots);module.font_manager=types.SimpleNamespace(FontProperties=Stub);module.dates=types.SimpleNamespace(DateFormatter=lambda *a:None);module.ticker=types.SimpleNamespace(FormatStrFormatter=lambda *a:None);sys.modules['matplotlib']=module
reference=runpy.run_path(sys.argv[1]);request=json.load(sys.stdin)
with tempfile.NamedTemporaryFile(mode='w+',encoding='utf-8') as f:
 f.write(request['text']);f.flush()
 if request.get('inMemory'): reference['parse_log'].__globals__['open']=lambda *a,**k:io.StringIO(request['text'],newline=None)
 start=time.perf_counter();data=reference['parse_log'](f.name,request.get('mcu'));plots=[]
 for fn,arg in [('plot_mcu',25000),('plot_system',None),('plot_mcu_frequencies',None),('plot_mcu_frequency','mcu'),('plot_temperature','heater, absent')]:
  reference[fn](data,*([] if arg is None else [arg]));plots.append(dict(state));state.clear()
 elapsed=(time.perf_counter()-start)*1000
print(json.dumps(dict(samples=[dict(time=d['#sampletime'],values={k:v for k,v in d.items() if k!='#sampletime'}) for d in data],plots=plots,elapsedMs=elapsed),allow_nan=False))
`;
export function graphstatsReference(text:string,mcu?:string,inMemory=false):{samples:unknown;plots:unknown[];elapsedMs:number}{return JSON.parse(execFileSync('/usr/bin/python3',['-c',source,fileURLToPath(new URL('../../scripts/graphstats.py',import.meta.url))],{input:JSON.stringify({text,mcu,inMemory}),encoding:'utf8',maxBuffer:256*1024**2}));}
