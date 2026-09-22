import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {delimiter} from 'node:path';
import type {MotanSOSMode} from '../../src/motan/sos-filter.ts';

export interface SOSCase {
  kind: 'lowpass' | 'highpass' | 'bandpass' | 'notch';
  order: number; cutoff: number | number[]; source: number[];
  mode: MotanSOSMode; fs?: number;
}
export interface SOSReference {sos: number[][]; values: number[]; ms: number[];}
export function sosOracle(cases: SOSCase[], bench = false): SOSReference[] {
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
 result.append(dict(sos=sos.tolist(),values=values.tolist(),ms=ms))
print(json.dumps(result))`;
  const roots = ['scipy-reference', 'pdf-reference'].map(name =>
    fileURLToPath(new URL(`../../node_modules/.cache/${name}`, import.meta.url)));
  return JSON.parse(execFileSync(process.env.MOTAN_SCIPY_PYTHON ?? 'python3', ['-c', script], {
    input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 64 * 1024 ** 2,
    env: {...process.env, OPENBLAS_NUM_THREADS: '1',
      PYTHONPATH: [...roots, process.env.PYTHONPATH ?? ''].join(delimiter)},
  }));
}
