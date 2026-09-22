import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {delimiter} from 'node:path';
import type {MotanSOSMode} from '../../src/motan/sos-filter.ts';

export interface SOSCase {
  kind: 'lowpass' | 'highpass' | 'bandpass' | 'notch';
  order: number; cutoff: number | number[]; source: number[];
  mode: MotanSOSMode; fs?: number;
}
export interface SOSReference {sos: number[][]; values: number[]; ms: number[]; ideal?: number[];}
export function scipyReferenceEnvironment(): NodeJS.ProcessEnv {
  const roots = ['scipy-reference', 'pdf-reference'].map(name =>
    fileURLToPath(new URL(`../../node_modules/.cache/${name}`, import.meta.url)));
  return {...process.env, OPENBLAS_NUM_THREADS: '1',
    PYTHONPATH: [...roots, process.env.PYTHONPATH ?? ''].join(delimiter)};
}
export function sosOracle(cases: SOSCase[], bench = false, highPrecision = false): SOSReference[] {
  const script = `import json,sys,time,numpy as np,scipy
from scipy.signal import butter,iirnotch,tf2sos,sosfilt,sosfiltfilt,sosfilt_zi
assert scipy.__version__ == '1.17.1', scipy.__version__
result=[]
for c in json.load(sys.stdin):
 fs=c.get('fs',1000)
 if c['kind']=='notch':
  b,a=iirnotch(c['cutoff'],c['order'],fs=fs);sos=tf2sos(b,a)
 else: sos=butter(c['order'],c['cutoff'],c['kind'],output='sos',fs=fs)
 source=c['source']
 def run():
  x=np.array(source,dtype=np.float64)
  if c['mode']=='filt': return sosfilt(sos,x,zi=sosfilt_zi(sos)*x[0])[0]
  return sosfiltfilt(sos,x)
 values=run();ms=[]
 if ${bench ? 'True' : 'False'}:
  for i in range(9):
   start=time.perf_counter();run();elapsed=(time.perf_counter()-start)*1000
   if i>=2: ms.append(elapsed)
 entry=dict(sos=sos.tolist(),values=values.tolist(),ms=ms)
 if ${highPrecision ? 'True' : 'False'}:
  import mpmath as mp
  assert mp.__version__=='1.3.0'
  assert c['kind']=='notch'
  mp.mp.dps=80
  omega=2*mp.mpf(c['cutoff'])/fs*mp.pi
  gain=1/(1+mp.tan(omega/mp.mpf(c['order'])/2))
  b0=b2=gain;b1=a1=-2*gain*mp.cos(omega);a2=2*gain-1
  def apply(x):
   z0=(1-b0)*x[0];z1=(b2-a2)*x[0];out=[]
   for sample in x:
    y=b0*sample+z0;z0=b1*sample-a1*y+z1;z1=b2*sample-a2*y;out.append(y)
   return out
  x=list(map(mp.mpf,source))
  if c['mode']=='filtfilt':
   edge=9;x=[2*x[0]-x[j] for j in range(edge,0,-1)]+x+[2*x[-1]-x[-j-2] for j in range(edge)]
   ideal=apply(apply(x)[::-1])[::-1][edge:-edge]
  else: ideal=apply(x)
  entry['ideal']=list(map(float,ideal))
 result.append(entry)
print(json.dumps(result))`;
  return JSON.parse(execFileSync(process.env.MOTAN_SCIPY_PYTHON ?? 'python3', ['-c', script], {
    input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 64 * 1024 ** 2,
    env: scipyReferenceEnvironment(),
  }));
}
