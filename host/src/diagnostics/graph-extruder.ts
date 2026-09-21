// Based on scripts/graph_extruder.py, Copyright (C) 2019-2021 Kevin O'Connor.
// GPL-3.0-or-later. Offline diagnostic simulation, not a motion controller.
import type {StatsPlot} from './graphstats.ts';
export const SEG_TIME=.000100,INV_SEG_TIME=1/SEG_TIME,MARGIN_TIME=.050;
export const EXTRUDE_R=(.4*.4*.75)/(Math.PI*(1.75/2)**2),ACCEL=3000*EXTRUDE_R;
export const MOVES:readonly (readonly [number,number,number|null])[]=Object.freeze([
 [0,0,.100],[0,100,null],[100,100,.200],[100,60,null],
 [60,100,null],[100,100,.200],[100,0,null],[0,0,.300],
].map(move=>Object.freeze(move) as readonly [number,number,number|null]));
export function extruderPositions():number[]{
 const out:number[]=[];let startD=0,startT=0,t=0;
 for(const [initial,final,duration] of MOVES){const startV=initial*EXTRUDE_R,endV=final*EXTRUDE_R,moveT=duration??Math.abs(endV-startV)/ACCEL,halfAccel=endV>startV?.5*ACCEL:startV>endV?-.5*ACCEL:0,endT=startT+moveT;
  while(t<=endT){const relT=t-startT;out.push(startD+(startV+halfAccel*relT)*relT);t+=SEG_TIME;}
  startD+=(startV+halfAccel*moveT)*moveT;startT=endT;
 }return out;
}
export function extruderDerivative(data:readonly number[]):number[]{return [0,...data.slice(1).map((v,i)=>(v-data[i])*INV_SEG_TIME)];}
const index=(time:number)=>Math.trunc(time*INV_SEG_TIME+.5),drop=index(MARGIN_TIME);
export function rawPressureAdvance(positions:readonly number[]):number[]{const out=Array<number>(positions.length).fill(0),pa=.045*INV_SEG_TIME;for(let i=drop;i<positions.length-drop;i++)out[i]=positions[i]+pa*(positions[i+1]-positions[i]);return out;}
export function weightedExtruder(positions:readonly number[],smoothTime=.040):number[]{
 if(!Number.isFinite(smoothTime)||smoothTime<=0||smoothTime>2*MARGIN_TIME)throw new RangeError('Smoothing must fit the diagnostic margin');
 const offset=index(smoothTime*.5);if(offset<1)throw new RangeError('Smoothing is below sample resolution');const weight=1/offset**2,out=Array<number>(positions.length).fill(0);
 for(let i=drop;i<positions.length-drop;i++){let sum=0,correction=0;for(let j=i-offset;j<i+offset;j++){const value=positions[j]*(offset-Math.abs(j-i)),next=sum+value;correction+=Math.abs(sum)>=Math.abs(value)?(sum-next)+value:(value-next)+sum;sum=next;}out[i]=(sum+correction)*weight;}return out;
}
export function extruderPlot():StatsPlot{
 const positions=extruderPositions(),velocities=extruderDerivative(positions),raw=rawPressureAdvance(positions),paVelocities=extruderDerivative(raw),smooth=weightedExtruder(raw),smVelocities=extruderDerivative(smooth),keep=positions.length-index(2*MARGIN_TIME),times=Array.from({length:keep},(_,i)=>SEG_TIME*i);
 return {title:'Extruder Velocity',axes:['Velocity (mm/s)'],curves:[['Pressure Advance',paVelocities],['Nominal',velocities],['Smooth PA',smVelocities]].map(([label,values])=>({label:label as string,axis:0,style:'line',times:[...times],values:(values as number[]).slice(0,keep)}))};
}
