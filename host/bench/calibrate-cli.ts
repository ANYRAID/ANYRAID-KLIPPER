import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
const dir=mkdtempSync(join(tmpdir(),'calibrate-cli-bench-')),input=join(dir,'input.csv'),root=fileURLToPath(new URL('../../scripts/',import.meta.url));
try{writeFileSync(input,'freq,psd_x,psd_y,psd_z,psd_xyz\n'+Array.from({length:256},(_,i)=>{const f=i*.9,p=.01+Math.exp(-(((f-43)/7)**2));return `${f},0,0,${p},${p}`;}).join('\n'));const results:Record<string,unknown>={};let recommendation:string|undefined;for(const [name,executable,script] of [['node',process.execPath,'calibrate_shaper.ts'],['python',process.env.PYTHON??'python3','calibrate_shaper.py']]){const times:number[]=[];for(let run=0;run<16;run++){const at=performance.now(),out=execFileSync(executable,[join(root,script),'--shaper_freq','30:80:5','-c',join(dir,name+'.csv'),input],{encoding:'utf8',maxBuffer:1024**2}),duration=performance.now()-at,selected=out.match(/Recommended shaper is (.+)/)?.[1];assert.ok(selected);recommendation??=selected;assert.equal(selected,recommendation);if(run>=5)times.push(duration);}times.sort((a,b)=>a-b);results[name]={medianMs:times[5],p95Ms:times[10]};}console.log(JSON.stringify({nodeVersion:process.version,warmups:5,runs:11,bins:256,frequencyRange:'30:80:5',recommendation,...results,scope:'Full CLI startup, file parsing, normalization, fitting and CSV output; Node includes worker startup and full precision CSV/atomic replacement. Python rounds CSV. No image encoding or printer timing.'},null,2));}finally{rmSync(dir,{recursive:true,force:true});}
