import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {MotanLogReader} from '../src/motan/log-reader.ts';
import {MotanDispatcher,MotanStatusTracker} from '../src/motan/dispatch.ts';
const baseline=JSON.parse(await readFile(new URL('../contracts/motan-io-python-baselines.json',import.meta.url),'utf8'));
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {median:values[3],p95:values[6]};};
const dir=await mkdtemp(join(tmpdir(),'motan-dispatch-bench-'));try{console.log(JSON.stringify({node:process.version,reference:baseline.dispatch[0].hash,warmup:2,measured:7,scope:'Node only; original Python timings are historical in motan-io-python-baselines.json'}));for(const [rounds,rows] of (process.argv.includes('--small')?[[10000,1]]:[[10000,1],[256,1000]])){
 const prefix=join(dir,`${rounds}-${rows}`),records=[];for(let i=0;i<rounds;i++){records.push(JSON.stringify({q:'status',params:{status:{toolhead:{estimated_print_time:i},heater:{temperature:20+i%10}}}}));for(const q of ['x','y'])records.push(JSON.stringify({q,params:{seq:i,data:Array.from({length:rows},(_,j)=>[i+j/1000,Math.sin(i+j),Math.cos(i-j)])}}));}await writeFile(prefix+'.json.gz',gzipSync(records.join('\x03')+'\x03'));
 const expected=Array.from({length:rounds},(_,i)=>20+i%10+3*(i+rows)).reduce((a,b)=>a+b,0);const reference=baseline.dispatch.find((row:any)=>row.rounds===rounds&&row.rows===rows);assert.equal(expected,reference.checksum);const times=[],lag=monitorEventLoopDelay({resolution:1});lag.enable();for(let run=0;run<9;run++){const start=performance.now(),reader=await MotanLogReader.open(prefix+'.json.gz'),dispatch=new MotanDispatcher(reader);let checksum=0;try{for(const [name,q] of [['s','status'],['x','x'],['y','y'],['x2','x']])dispatch.addHandler(name,q);const tracker=new MotanStatusTracker({},time=>dispatch.pull(time,'s'));for(let i=0;i<rounds;i++){const {status}=await tracker.sample(i+.25);checksum+=(status.heater as {temperature:number}).temperature;for(const name of ['x','y','x2']){const p=(await dispatch.pull(i+.25,name))!;checksum+=(p.seq as number)+(p.data as unknown[]).length;}}assert.equal(await dispatch.pull(1e9,'x'),null);assert.equal(dispatch.status.endOfData,true);}finally{dispatch.close();await reader.close();}const elapsed=performance.now()-start;assert.equal(checksum,expected);if(run>=2)times.push(elapsed);}lag.disable();console.log(JSON.stringify({rounds,rows,node:stats(times),maxEventLoopMs:lag.max/1e6,checksum:expected}));}
}finally{await rm(dir,{recursive:true,force:true});}
