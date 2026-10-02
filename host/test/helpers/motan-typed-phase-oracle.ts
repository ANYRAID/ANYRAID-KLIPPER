import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
export function typedPhaseOracle(raw:string,microstep=false,bench=false):{values:[string,string][];ms:number[]}{
 const source=execFileSync('git',['show','2c7ba578:scripts/motan/readlog.py']);if(createHash('sha256').update(source).digest('hex')!=='f89b7eff1f4592399d9eb9ad0f679d894cb9a0d2a40a79f81f48d139c16e9ca2')throw new Error('Motan source changed');
 const script=`import json,sys,time,struct
scope={}
exec(${JSON.stringify(source.toString())},scope)
x=json.load(sys.stdin)
class Manager:
 def __init__(self): self.blocks=iter(x['blocks'])
 def get_jdispatch(self): return self
 def get_status_tracker(self): return self
 def get_initial_status(self): return {'configfile':{'settings':x['settings']}}
 def add_handler(self,*args): pass
 def pull_msg(self,*args): return next(self.blocks,None)
 def pull_status(self,t):
  rows=x['offsets'];i=0
  while i+1<len(rows) and rows[i+1][0]<=t: i+=1
  return {'tmc2209 stepper_x':{'mcu_phase_offset':rows[i][1]}}, rows[i+1][0] if i+1<len(rows) else 1e9
def run():
 h=scope['HandleStepPhase'](Manager(),'p',['step_phase','tmc2209 stepper_x']+(${microstep?'True':'False'} and ['microstep'] or []))
 return [h.pull_data(t) for t in x['times']]
values=run();ms=[]
if ${bench?'True':'False'}:
 for i in range(9):
  start=time.perf_counter();run();elapsed=(time.perf_counter()-start)*1000
  if i>=2: ms.append(elapsed)
print(json.dumps(dict(values=[['int',str(v)] if type(v)==int else ['float',struct.pack('>d',v).hex()] for v in values],ms=ms)))`;
 return JSON.parse(execFileSync('python3',['-c',script],{input:raw,encoding:'utf8',maxBuffer:32*1024**2}));
}
