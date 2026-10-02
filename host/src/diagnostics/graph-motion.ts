// Legacy offline motion demonstration, not the production planner.
// Based on scripts/graph_motion.py, Kevin O'Connor (2019-2021),
// Dmitry Butyugin (2020). GPL-3.0-or-later.
import {applyLegacyMotionShaper,type LegacyMotionShaper} from './legacy-motion-shaper.ts';
import {filterMotion,type MotionFilter} from './motion-filters.ts';
import type {StatsPanel} from './stats-svg.ts';
const dt=.0001,inv=1/dt,accel=3000;
const moves:readonly (readonly [number,number,number|null])[]=[[0,0,.1],[6.869,89.443,null],[89.443,89.443,.12],[89.443,17.361,null],[19.410,120,null],[120,120,.13],[120,5,null],[0,0,.01],[-5,-100,null],[-100,-100,.1],[-100,-.5,null],[0,0,.2]];
const derivative=(data:number[])=>[0,...data.slice(1).map((v,i)=>(v-data[i])*inv)];
export interface MotionProfileOptions {order?:2|4|6;jerkLimit?:boolean;legacyShaper?:LegacyMotionShaper;}
function accelerationPosition(t:number,v:number,a:number,duration:number,order:2|4|6):number{
 if(order===2)return (v+.5*a*t)*t;
 const invDuration=1/duration,a1=a*invDuration,a2=a1*invDuration;
 if(order===4)return ((-.5*a2*t+a1)*t*t+v)*t;
 const a3=a2*invDuration,a4=a3*invDuration;
 return (((a4*t-3*a3)*t+2.5*a2)*t*t*t+v)*t;
}
export function motionPositions(options:MotionProfileOptions={}):number[]{
 const order=options.order??2;if(![2,4,6].includes(order)||(options.jerkLimit!==undefined&&typeof options.jerkLimit!=='boolean'))throw new RangeError('Invalid diagnostic motion profile');
 const out:number[]=[];let startD=0,startT=0,time=0;
 for(const [v,endV,duration] of moves){const effective=options.jerkLimit?Math.min(Math.sqrt((accel*.6*35)*Math.abs(endV-v)/6),accel):accel,durationS=duration??Math.abs(endV-v)/effective,a=(endV-v)/durationS,end=startT+durationS;
  while(time<=end){out.push(startD+accelerationPosition(time-startT,v,a,durationS,order));time+=dt;}
  startD+=accelerationPosition(durationS,v,a,durationS,order);startT=end;
 }return out;
}
function spring(input:number[]):number[]{const omega2=(35*2*Math.PI)**2,damping=4*Math.PI*.05*35;let position=0,velocity=0;return input.map(stepper=>{position+=velocity*dt;const a=(stepper-position)*omega2;velocity+=a*dt;velocity-=velocity*damping*dt;return position;});}
export interface MotionPlotStages {nominal:number[];updated:number[];head:number[];newHead:number[];velocity:number[][];acceleration:number[][];}
export function motionPlots(filter?:MotionFilter,smoothTime?:number,profile:MotionProfileOptions={},capture?:(stages:MotionPlotStages)=>void):StatsPanel[]{
 if(filter&&profile.legacyShaper!==undefined)throw new RangeError('Choose a filter or legacy shaper');
 const nominal=motionPositions(profile),updated=filter?filterMotion(nominal,filter,smoothTime):applyLegacyMotionShaper(nominal,profile.legacyShaper),head=spring(nominal),newHead=spring(updated),velocity=[updated,nominal,head,newHead].map(derivative),acceleration=velocity.map(derivative),deviation=[newHead.map((v,i)=>v-nominal[i]),head.map((v,i)=>v-nominal[i])],keep=nominal.length-1000,times=Array.from({length:keep},(_,i)=>dt*i),xAxis={label:'Time (s)',format:'number' as const};
 const panel=(title:string,axis:string,labels:string[],values:number[][]):StatsPanel=>({xAxis,plot:{title,axes:[axis],curves:values.map((v,i)=>({label:labels[i],axis:0,style:'line',times:[...times],values:v.slice(0,keep)}))}});
 capture?.({nominal,updated,head,newHead,velocity,acceleration});
 const profileLabel=`Order ${profile.order??2}${profile.jerkLimit?' / jerk limit':''}${filter?'':' / '+(profile.legacyShaper??'ei')}`;
 const accelerationPanel=panel(profileLabel+' acceleration','Acceleration (mm/s^2)',['New Accel','Nominal Accel','Head Accel','New Head Accel'],acceleration);accelerationPanel.yRanges=[[-5*accel,5*accel]];
 return [panel(filter?`Filter ${filter}: resonance 35 Hz / damping 0.05; configured 40 Hz / 0.1`:'Simulation: resonance 35 Hz / damping 0.05; configured 40 Hz / 0.1','Velocity (mm/s)',['New Velocity','Nominal Velocity','Head Velocity','New Head Velocity'],velocity),accelerationPanel,panel('Spring deviation','Deviation (mm)',['New','Nominal'],deviation)];
}
