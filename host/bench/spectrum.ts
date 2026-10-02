// Development-only comparison with the unmodified Python/NumPy implementation.
import { spawnSync } from 'node:child_process';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir,cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance,monitorEventLoopDelay } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { calculateSpectrum } from '../src/calibration/spectrum.ts';
import { SpectrumExecutor } from '../src/calibration/background.ts';
const python=process.env.PYTHON??'python3';
const oracle=String.raw`
import sys,json,time,types
import numpy as np
sys.path.insert(0,sys.argv[1]); sys.modules['queuelogger']=types.ModuleType('queuelogger')
from extras.shaper_calibrate import ShaperCalibrate
raw=np.fromfile(sys.argv[2],dtype='<f8').reshape((-1,4))
c=ShaperCalibrate(None)
for _ in range(3): c.calc_freq_response('bench',raw)
times=[]
for _ in range(15):
    start=time.perf_counter(); r=c.calc_freq_response('bench',raw); times.append((time.perf_counter()-start)*1000)
print(json.dumps({'numpy':np.__version__,'times':sorted(times),'frequencies':r.freq_bins.tolist(),'x':r.psd_x.tolist(),'y':r.psd_y.tolist(),'z':r.psd_z.tolist(),'sum':r.psd_sum.tolist()}))
`;
const dir=mkdtempSync(join(tmpdir(),'anyraid-spectrum-'));
const reports=[];
try {
  for(const n of [8192,65536,262144]) {
    const raw=new Float64Array(n*4);
    for(let i=0;i<n;i++) {
      raw[4*i]=i/3200;
      raw[4*i+1]=3+200*Math.sin(2*Math.PI*43*i/3200)+30*Math.cos(2*Math.PI*79*i/3200);
      raw[4*i+2]=100*Math.cos(2*Math.PI*67*i/3200);
      raw[4*i+3]=50*Math.sin(2*Math.PI*123*i/3200);
    }
    const path=join(dir,'samples.bin');
    writeFileSync(path,Buffer.from(raw.buffer));
    const run=spawnSync(python,['-c',oracle,fileURLToPath(new URL('../../klippy',import.meta.url)),path],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
    if(run.status!==0) throw new Error(run.stderr||String(run.error));
    const reference=JSON.parse(run.stdout), result=calculateSpectrum('bench',raw)!;
    let maxRelativeError=0,maxAbsoluteError=0;
    for(const key of ['frequencies','x','y','z','sum'] as const) {
      assert.equal(result[key].length,reference[key].length);
      result[key].forEach((v,i) => {
        const delta=Math.abs(v-reference[key][i]);
        maxAbsoluteError=Math.max(maxAbsoluteError,delta);
        maxRelativeError=Math.max(maxRelativeError,delta/Math.max(1e-12,Math.abs(reference[key][i])));
        assert.ok(delta<=1e-9+Math.abs(reference[key][i])*1e-10,`${key}[${i}] differs`);
      });
    }
    for(let i=0;i<3;i++) calculateSpectrum('bench',raw);
    const times=[];
    for(let i=0;i<15;i++) { const start=performance.now(); calculateSpectrum('bench',raw); times.push(performance.now()-start); }
    times.sort((a,b) => a-b);
    const delay=monitorEventLoopDelay({resolution:1}); delay.enable();
    let ticks=0; const heartbeat=setInterval(() => ticks++,1);
    const executor=new SpectrumExecutor(), start=performance.now();
    try { await executor.calculate('bench',raw); } finally { clearInterval(heartbeat); delay.disable(); }
    reports.push({samples:n,numpy:reference.numpy,maxAbsoluteError,maxRelativeError,nodeMedianMs:times[7],numpyMedianMs:reference.times[7],nodeP95Ms:times[14],numpyP95Ms:reference.times[14],workerWallMs:performance.now()-start,heartbeatTicks:ticks,eventLoopP99Ms:delay.percentile(99)/1e6});
    assert.ok(ticks>0,'Calibration blocked heartbeat');
  }
} finally { rmSync(dir,{recursive:true,force:true}); }
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,reports},null,2));
