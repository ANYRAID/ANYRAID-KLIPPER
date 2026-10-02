import {LinearKinematics} from '../../src/kinematics/linear.ts';
import {GCodeMove} from '../../src/gcode/move.ts';
import {LinearHomingCommand,type LinearHomingPort,type HomingPass} from '../../src/homing/linear-command.ts';
import {StepHistory} from '../../src/motion/step-history.ts';
export function homingPass(kind:'hit'|'miss'|'stuck'='hit'):HomingPass{
 const clock=kind==='stuck'?0n:10n,history=new StepHistory(0n,0n);history.append({history:new BigInt64Array([1n,20n,0n,20n,1n,0n]),position:20n},20n);
 const single={hitClock:kind==='miss'?null:clock,reasons:[kind==='miss'?3:1],positions:[{member:0,oid:1,raw:12,position:12n,observedClock:20n}]};
 return {movingSteppers:[{member:0,oid:1}],stop:{hitClock:null,groups:[single],memberOffsets:[0],reasons:single.reasons,positions:single.positions},histories:[{member:0,oid:1,history}],triggerClocks:[[clock]]};
}
export function linearHomingFixture(options:{pass?:(attempt:number,signal:AbortSignal)=>Promise<HomingPass>;retractDistance?:number;timeoutMs?:number}={}){
 const kin=new LinearKinematics({kind:'corexy',ranges:[[0,200],[0,200],[0,200]],maxVelocity:300,maxAccel:3000,maxZVelocity:20,maxZAccel:100});
 let position=[25,35,40,7],stops=0,attempt=0;const events:{kind:string;position:number[];speed?:number;axis?:number}[]=[];
 const port:LinearHomingPort={assertActive(){},position:()=>position,move(p,speed){position=[...p];events.push({kind:'move',position:[...p],speed});},async drain(s){s.throwIfAborted();events.push({kind:'drain',position:[...position]});},async forcePosition(p,s){s.throwIfAborted();position=[...p];events.push({kind:'force',position:[...p]});},async home(p,speed,axis,s){events.push({kind:'home',position:[...p],speed,axis});if(kin.status.homedAxes.includes('xyz'[axis]))throw new Error('Premature homing authority');const result=await (options.pass?.(++attempt,s)??Promise.resolve(homingPass()));s.throwIfAborted();position=[...p];position[axis]+=.02;return result;},async retract(p,speed,axis,s){s.throwIfAborted();events.push({kind:'retract',position:[...p],speed,axis});position=[...p];},async motorOff(){stops++;}};
 const coordinates=new GCodeMove(port),rails=[0,1,2].map(axis=>({endstop:axis===1?200:0,positiveDirection:axis===1,speed:40,retractDistance:options.retractDistance??5,retractSpeed:20,secondSpeed:10,endstops:[`stepper_${'xyz'[axis]}`]}));
 const command=new LinearHomingCommand(kin,coordinates,port,rails,options.timeoutMs);
 return {kin,port,coordinates,rails,command,events,get stops(){return stops;}};
}
