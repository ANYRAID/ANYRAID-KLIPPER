// Legacy offline motion demonstration, not the production planner.
// Based on scripts/graph_motion.py, Kevin O'Connor (2019-2021),
// Dmitry Butyugin (2020). GPL-3.0-or-later.
import {filterMotion,type MotionFilter} from './motion-filters.ts';
import type {StatsPanel} from './stats-svg.ts';
const dt=.0001,inv=1/dt,accel=3000,margin=500;
const moves:readonly (readonly [number,number,number|null])[]=[[0,0,.1],[6.869,89.443,null],[89.443,89.443,.12],[89.443,17.361,null],[19.410,120,null],[120,120,.13],[120,5,null],[0,0,.01],[-5,-100,null],[-100,-100,.1],[-100,-.5,null],[0,0,.2]];
function sum(values:readonly number[]):number{let high=0,low=0;for(const value of values){const next=high+value;low+=Math.abs(high)>=Math.abs(value)?(high-next)+value:(value-next)+high;high=next;}return high+low;}
const derivative=(data:number[])=>[0,...data.slice(1).map((v,i)=>(v-data[i])*inv)];
function positions():number[]{const out:number[]=[];let startD=0,startT=0,time=0;for(const [v,endV,duration] of moves){const durationS=duration??Math.abs(endV-v)/accel,a=(endV-v)/durationS,end=startT+durationS;while(time<=end){const t=time-startT;out.push(startD+(v+.5*a*t)*t);time+=dt;}startD+=(v+.5*a*durationS)*durationS;startT=end;}return out;}
function spring(input:number[]):number[]{const omega2=(35*2*Math.PI)**2,damping=4*Math.PI*.05*35;let position=0,velocity=0;return input.map(stepper=>{position+=velocity*dt;const a=(stepper-position)*omega2;velocity+=a*dt;velocity-=velocity*damping*dt;return position;});}
function legacyEI(input:number[]):number[]{const df=Math.sqrt(1-.1**2),k=Math.exp(-.1*Math.PI/df),period=1/(40*df),a1=.25*(1+.05),a=[a1,.5*(1-.05)*k,a1*k*k],times=[0,.5*period,period],shift=sum(a.map((v,i)=>v*times[i]))/sum(a),offsets=times.map(t=>Math.trunc(-(t-shift)*inv+.5)),gain=1/sum(a),out=Array<number>(input.length).fill(0);for(let i=margin;i<input.length-margin;i++)out[i]=sum(a.map((v,j)=>input[i+offsets[j]]*v))*gain;return out;}
export function motionPlots(filter?:MotionFilter,smoothTime?:number):StatsPanel[]{
 const nominal=positions(),updated=filter?filterMotion(nominal,filter,smoothTime):legacyEI(nominal),head=spring(nominal),newHead=spring(updated),velocity=[updated,nominal,head,newHead].map(derivative),acceleration=velocity.map(derivative),deviation=[newHead.map((v,i)=>v-nominal[i]),head.map((v,i)=>v-nominal[i])],keep=nominal.length-1000,times=Array.from({length:keep},(_,i)=>dt*i),xAxis={label:'Time (s)',format:'number' as const};
 const panel=(title:string,axis:string,labels:string[],values:number[][]):StatsPanel=>({xAxis,plot:{title,axes:[axis],curves:values.map((v,i)=>({label:labels[i],axis:0,style:'line',times:[...times],values:v.slice(0,keep)}))}});
 const accelerationPanel=panel('Acceleration','Acceleration (mm/s^2)',['New Accel','Nominal Accel','Head Accel','New Head Accel'],acceleration);accelerationPanel.yRanges=[[-5*accel,5*accel]];
 return [panel(filter?`Filter ${filter}: resonance 35 Hz / damping 0.05; configured 40 Hz / 0.1`:'Simulation: resonance 35 Hz / damping 0.05; configured 40 Hz / 0.1','Velocity (mm/s)',['New Velocity','Nominal Velocity','Head Velocity','New Head Velocity'],velocity),accelerationPanel,panel('Spring deviation','Deviation (mm)',['New','Nominal'],deviation)];
}
