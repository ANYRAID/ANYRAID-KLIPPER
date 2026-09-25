import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planArc,arcSegment,type ArcPlane} from '../src/gcode/arcs.ts';
import {GCodeMove,type Parameters} from '../src/gcode/move.ts';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
import {idleMotionFixture} from '../test/helpers/idle-motion.ts';
const origin=[50,0,0,2],cases:{plane:ArcPlane;clockwise:boolean;absolute:boolean;resolution:number;params:Record<string,number>}[]=[];
for(const plane of [0,1,2] as const)for(const clockwise of [false,true])for(const absolute of [false,true])for(const resolution of [.25,1])for(const helix of [0,3]){
 const params:Record<string,number>={F:600,E:absolute?2.2:.2};params[plane===2?'J':'I']=10;params[plane===0?'Z':plane===1?'Y':'X']=(plane===2?50:0)+helix;cases.push({plane,clockwise,absolute,resolution,params});
}
cases.push({plane:0,clockwise:true,absolute:true,resolution:1,params:{X:50.001,I:.0005}},{plane:0,clockwise:false,absolute:true,resolution:.25,params:{X:60,Y:10,I:10,E:2,F:1200}});
for(const plane of [0,1,2] as const)for(const angle of [-3.14,-1.3,.001,.9,2.7])for(const clockwise of [false,true]){
 const [a,b,h]=plane===0?[0,1,2]:plane===1?[0,2,1]:[1,2,0],offset=[-3,4],params:Record<string,number>={E:2.03,F:1200};params[plane===2?'J':'I']=offset[0];params[plane===0?'J':'K']=offset[1];params['XYZ'[a]]=origin[a]+offset[0]-offset[0]*Math.cos(angle)+offset[1]*Math.sin(angle);params['XYZ'[b]]=origin[b]+offset[1]-offset[0]*Math.sin(angle)-offset[1]*Math.cos(angle);params['XYZ'[h]]=origin[h]+.7;cases.push({plane,clockwise,absolute:true,resolution:.2,params});
}
const iterations=400,python=String.raw`
import json,runpy,sys,time
module=runpy.run_path(sys.argv[1]);Arc=module['ArcSupport'];cases=json.loads(sys.argv[2]);origin=[50.,0.,0.,2.]
class Command:
 def __init__(self,p):self.p=p
 def get_float(self,k,default=None):return float(self.p[k]) if k in self.p else default
 def error(self,s):return ValueError(s)
class Coordinates:
 def get_status(self):return dict(absolute_coordinates=True,gcode_position=origin,absolute_extrude=self.absolute)
 def cmd_G1(self,p):self.points.append(p)
class Dispatch:
 def create_gcode_command(self,a,b,p):return p
arc=Arc.__new__(Arc);arc.gcode_move=Coordinates();arc.gcode=Dispatch()
def run(c):
 arc.plane=c['plane'];arc.mm_per_arc_segment=c['resolution'];arc.gcode_move.absolute=c['absolute'];arc.gcode_move.points=[];arc._cmd_inner(Command(c['params']),c['clockwise']);return arc.gcode_move.points
results=[run(c) for c in cases];times=[];checksum=0
for sample in range(14):
 start=time.perf_counter()
 for i in range(int(sys.argv[3])):checksum+=len(run(cases[i%len(cases)]))
 if sample>=3:times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(results=results,times=sorted(times),checksum=checksum)))
`;
const result=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/extras/gcode_arcs.py',import.meta.url)),JSON.stringify(cases),String(iterations)],{encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});if(result.status!==0)throw new Error(result.stderr||String(result.error));const reference=JSON.parse(result.stdout) as {results:Record<string,number>[][];times:number[];checksum:number};
function run(index:number){const c=cases[index],p=planArc(origin,c.absolute,c.params,c.clockwise,c.plane,c.resolution);return Array.from({length:p.segments},(_,i)=>arcSegment(p,i));}
let maxCoordinateError=0,segmentsCompared=0,stepsCompared=0,maxTickDifference=0n;
async function native(params:readonly Parameters[],absolute:boolean,filtered:boolean){const f=idleMotionFixture(filtered),q=new LookAheadQueue(),limits=motionLimits(100,1000);let position=[...origin];const gcode=new GCodeMove({position:()=>position,move:(p,speed)=>{q.add(new Move(limits,position,p,speed));position=[...p];}});if(!absolute)gcode.execute('M83');try{for(const p of params)gcode.execute('G1',p);f.source.startAt(1);await f.source.drain(q.flush(),new AbortController().signal);assert.equal(f.stops,0);return {ticks:f.ticks,positions:f.positions};}finally{f.close();}}
for(let i=0;i<cases.length;i++){
 const actual=run(i),expected=reference.results[i];assert.equal(actual.length,expected.length);segmentsCompared+=actual.length;
 for(let j=0;j<actual.length;j++){assert.deepEqual(Object.keys(actual[j]).sort(),Object.keys(expected[j]).sort());for(const key of Object.keys(expected[j])){const error=Math.abs(Number(actual[j][key])-expected[j][key]);assert(error<=1e-12*Math.max(1,Math.abs(expected[j][key])));maxCoordinateError=Math.max(error,maxCoordinateError);}}
 for(const filtered of [false,true]){const a=await native(expected,cases[i].absolute,filtered),b=await native(actual,cases[i].absolute,filtered);assert.deepEqual(a.positions,b.positions);for(const axis of ['x','e']){assert.equal(a.ticks[axis].length,b.ticks[axis].length);for(let j=0;j<a.ticks[axis].length;j++){assert.equal(a.ticks[axis][j][1],b.ticks[axis][j][1]);const delta=a.ticks[axis][j][0]-b.ticks[axis][j][0],abs=delta<0n?-delta:delta;assert(abs<=1n);if(abs>maxTickDifference)maxTickDifference=abs;stepsCompared++;}}}
}
let checksum=0;const times:number[]=[];for(let sample=0;sample<14;sample++){const start=performance.now();for(let i=0;i<iterations;i++)checksum+=run(i%cases.length).length;if(sample>=3)times.push(performance.now()-start);}times.sort((a,b)=>a-b);assert.equal(checksum,reference.checksum);
const limits={medianRatio:1.25,p95Ratio:1.5,slackMs:2};console.log(JSON.stringify({node:process.version,cases:cases.length,segmentsCompared,maxCoordinateError,stepsCompared,maxTickDifference:String(maxTickDifference),iterations,warmup:3,samples:11,nodeArc:{medianMs:times[5],p95Ms:times[10]},pythonArc:{medianMs:reference.times[5],p95Ms:reference.times[10]},limits,scope:'Repository Python arc commands versus TS geometry and parameter creation, followed by native X/E pulses with shaping and pressure advance. Memory sink; excludes UART and real printer timing.'}));assert(times[5]<=reference.times[5]*limits.medianRatio+limits.slackMs);assert(times[10]<=reference.times[10]*limits.p95Ratio+limits.slackMs);
