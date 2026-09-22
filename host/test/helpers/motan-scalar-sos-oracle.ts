import {execFileSync} from 'node:child_process';
import type {MotanScalarSeries} from '../../src/motan/scalar-math.ts';
import type {MotanSOS,MotanSOSMode} from '../../src/motan/sos-filter.ts';
import {scipyReferenceEnvironment,scipyReferencePython} from './motan-sos-oracle.ts';
export function scalarSOSOracle(source:MotanScalarSeries,sos:MotanSOS,mode:MotanSOSMode,bench=false):{dtype:string;bits?:string[];ms?:number[];error?:string}{
 const script=`import json,sys,struct,time,numpy as np,scipy
from scipy.signal import sosfilt,sosfiltfilt,sosfilt_zi
assert np.__version__=='2.5.3' and scipy.__version__=='1.17.1'
x=json.load(sys.stdin)
source=[int(v) if t=='bigint' else (v=='true') if t=='boolean' else float(v) for t,v in x['source']]
sos=np.array(x['sos'],dtype=np.float64)
def run():
 data=np.array(source)
 if x['mode']=='filt': return sosfilt(sos,data,zi=sosfilt_zi(sos)*data[0])[0]
 return sosfiltfilt(sos,data)
result=dict(dtype=str(np.array(source).dtype))
try:
 values=run();result['bits']=[struct.pack('>d',float(v)).hex() for v in values];ms=[]
 if ${bench?'True':'False'}:
  for i in range(9):
   start=time.perf_counter();run();elapsed=(time.perf_counter()-start)*1000
   if i>=2: ms.append(elapsed)
 result['ms']=ms
except Exception as error: result['error']=type(error).__name__+': '+str(error)
print(json.dumps(result))`;
 return JSON.parse(execFileSync(scipyReferencePython(),['-c',script],{input:JSON.stringify({source:Array.from(source,v=>[typeof v,Object.is(v,-0)?'-0':String(v)]),sos,mode}),encoding:'utf8',env:scipyReferenceEnvironment(),maxBuffer:64*1024**2}));
}
