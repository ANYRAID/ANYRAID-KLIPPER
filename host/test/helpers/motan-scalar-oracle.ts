import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import type {MotanScalarSeries} from '../../src/motan/scalar-math.ts';
export function scalarOracle(kind:string,first:MotanScalarSeries,second:MotanScalarSeries|undefined,segment=.01,bench=false,third?:MotanScalarSeries):{values:[string,string][];ms:number[]}{
 const source=execFileSync('git',['show','4127c89e:scripts/motan/analyzers.py']);
 if(createHash('sha256').update(source).digest('hex')!=='8e47954f05da42f9f33fa14224080547c5a54f64ddd36930973f6e42a77421ab')throw new Error('Motan scalar oracle source changed');
 const encode=(values:MotanScalarSeries)=>Array.from(values,v=>[typeof v,Object.is(v,-0)?'-0':String(v)]);
 const script=`import json,sys,types,time,struct
sys.modules['readlog']=types.ModuleType('readlog')
scope={}
exec(${JSON.stringify(source.toString())},scope)
x=json.load(sys.stdin)
def decode(data):
 return [int(v) if t=='bigint' else (v=='true') if t=='boolean' else float(v) for t,v in data]
data={'first':decode(x['first'])}
if 'second' in x: data['second']=decode(x['second'])
if 'third' in x: data['third']=decode(x['third'])
class Manager:
 error=ValueError
 def setup_dataset(self,name): pass
 def get_datasets(self): return data
 def get_segment_time(self): return x['segment']
def run():
 kind=x['kind']
 if kind.startswith('corexy_'): parts=['corexy',kind[-1],'first','second'];kind='corexy'
 else: parts=[kind,'first']+(['second'] if 'second' in data else [])+(['third'] if 'third' in data else [])
 return scope['AHandlers'][kind](Manager(),parts).generate_data()
values=run();ms=[]
if ${bench?'True':'False'}:
 for i in range(9):
  start=time.perf_counter();run();elapsed=(time.perf_counter()-start)*1000
  if i>=2: ms.append(elapsed)
print(json.dumps(dict(values=[['int',str(v)] if type(v)==int else ['float',struct.pack('>d',v).hex()] for v in values],ms=ms)))`;
 return JSON.parse(execFileSync('python3',['-c',script],{input:JSON.stringify({kind,first:encode(first),...(second===undefined?{}:{second:encode(second)}),...(third===undefined?{}:{third:encode(third)}),segment}),encoding:'utf8',maxBuffer:64*1024**2}));
}
export function scalarBits(values:MotanScalarSeries):[string,string][]{return Array.from(values,v=>{
 if(typeof v==='bigint')return ['int',v.toString()];
 if(typeof v!=='number')throw new Error('Expected arithmetic output');const b=Buffer.alloc(8);b.writeDoubleBE(v);return ['float',b.toString('hex')];
});}
