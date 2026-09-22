import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {DripMotion} from '../src/homing/drip-motion.ts';
import type {HomingTriggerSet,TriggerGroupOutcome} from '../src/homing/trigger-set.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
const oracle=JSON.parse(execFileSync('python3',['-c',String.raw`
import ast,json,types
source=ast.parse(open('klippy/extras/motion_queuing.py').read())
cls=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=='PrinterMotionQueuing')
method=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='drip_update_time')
constants=[n for n in source.body if isinstance(n,ast.Assign)]
scope={};exec(compile(ast.Module(body=constants+[method],type_ignores=[]),'reference','exec'),scope)
traces=[]
for count in (3,100000):
 trace=[]
 def advance(flush,gen=0):
  if gen>1 and (not trace or gen>trace[-1]):trace.append(gen)
 mock=types.SimpleNamespace(drip_start_times=[],_await_flush_time=lambda t:None,
  reactor=types.SimpleNamespace(update_timer=lambda *a:None,NEVER=1e99,NOW=0,monotonic=lambda:0),
  flush_timer=None,can_pause=True,kin_flush_delay=0,_advance_flush_time=advance,
  note_mcu_movequeue_activity=lambda t:None,
  mcu=types.SimpleNamespace(estimated_print_time=lambda t:trace[-1] if trace else 1))
 completion=types.SimpleNamespace(test=lambda:len(trace)>=count,wait=lambda t:None)
 scope['drip_update_time'](mock,1,11,completion);traces.append(trace)
print(json.dumps(traces))
`],{encoding:'utf8'})) as number[][];
async function run(managed:boolean,stopAfter:number){
 using q=new TrapQueue();q.appendRaw(new Float64Array([1,0,10,0,0,0,0,1,0,0,10,10,0]));
 using stepper=q.createStepper({frequency:1e6,timeOffset:0,oid:1,maxError:0,queueStepTag:5,directionTag:6},'x',.01);
 const trace:number[]=[],packets:string[]=[],history:string[]=[];let resolve!:(v:readonly TriggerGroupOutcome[])=>void;
 const completion=new Promise<readonly TriggerGroupOutcome[]>(r=>{resolve=r;});
 const c=new MotionCoordinator([{id:'x',queue:q,stepper}],{async commit(b){
  if(b.generatedUntil!>1){trace.push(b.generatedUntil!);for(const p of b.outputs[0].messages)packets.push(p.data.toString('hex'));history.push(b.outputs[0].history.join(','));if(trace.length===stopAfter)resolve([{group:0,member:0,reason:1}]);}
 },async stop(){assert.fail('unexpected stop');}});
 await c.advance(1);
 const t:Pick<HomingTriggerSet,'completion'|'status'|'stop'>={completion,status:{armed:true,released:false,remaining:1,failed:false,fault:undefined,cleanupPending:false,cleanupErrors:[]},async stop(){assert.fail('unexpected trigger stop');}};
 const start=performance.now();
 if(managed)await new DripMotion(c,t,{estimatedPrintTime:()=>c.status.generatedTime}).run(1,11,new AbortController().signal);
 else{let until=1;while(until<11&&trace.length<stopAfter){const next=Math.min(until+.05,11),flush=next===11?11:Math.max(c.status.committedTime,next-.002);await c.advance(next,0,flush);until=next;await new Promise<void>(r=>setImmediate(r));}}
 return {elapsed:performance.now()-start,trace,packets,history,position:stepper.commandedPosition};
}
for(const [index,count] of [3,100000].entries()){
 const a=await run(false,count),b=await run(true,count);
 assert.deepEqual(b.trace,oracle[index]);assert.deepEqual(b.trace,a.trace);assert.deepEqual(b.packets,a.packets);assert.deepEqual(b.history,a.history);assert.equal(b.position,a.position);
 const samples:number[][]=[[],[]];
 for(let round=0;round<24;round++)for(const mode of round%2?[1,0]:[0,1]){const result=await run(!!mode,count);assert.deepEqual(result.packets,a.packets);if(round>=3)samples[mode].push(result.elapsed);}
 for(const s of samples)s.sort((a,b)=>a-b);
 const stats=(s:number[])=>({medianMs:s[10],p95Ms:s[19]});
 console.log(JSON.stringify({node:process.version,segments:b.trace.length,pythonBoundaryParity:true,exactNativePacketsAndHistory:true,raw:stats(samples[0]),managed:stats(samples[1]),medianAddedMsPerSegment:(samples[1][10]-samples[0][10])/b.trace.length,scope:'native generation with synthetic MCU time and immediate sink; no UART or physical printing'}));
 assert(samples[1][10]/b.trace.length<1,'Median processing budget exceeded 1ms per 50ms segment');
 assert((samples[1][10]-samples[0][10])/b.trace.length<.25,'Additional median scheduling cost exceeded 0.25ms per segment');
}
