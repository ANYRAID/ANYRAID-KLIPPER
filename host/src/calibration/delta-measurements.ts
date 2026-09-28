// Geometry of docs/prints/calibrate_size.stl; derived from delta_calibrate.py.
// GPL-3.0-or-later, Kevin O'Connor 2017-2019.
import {DeltaCalibration,type DeltaCalibrationGeometry,type DeltaDistanceMeasurement} from './delta-calibration.ts';
export interface DeltaObjectMeasurements {scale:number;centerDistances:readonly number[];centerWidths:readonly number[];outerDistances:readonly number[];outerWidths:readonly number[];}
export function deltaObjectDistances(value:unknown,geometry:DeltaCalibrationGeometry):DeltaDistanceMeasurement[]{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new RangeError('Expected Delta object measurements');
 const p=value as DeltaObjectMeasurements;
 if(Object.keys(p).some(k=>!['scale','centerDistances','centerWidths','outerDistances','outerWidths'].includes(k))||!Number.isFinite(p.scale)||p.scale<=0)throw new RangeError('Invalid Delta object scale or fields');
 for(const [key,count] of [['centerDistances',6],['centerWidths',3],['outerDistances',6],['outerWidths',6]] as const){const a=p[key];if(!Array.isArray(a)||a.length!==count||!a.every(v=>Number.isFinite(v)&&v>0))throw new RangeError('Invalid Delta object '+key);}
 const cal=new DeltaCalibration(geometry),angles=[210,270,330,30,90,150].map(a=>a*Math.PI/180),xy=angles.map(a=>[Math.cos(a),Math.sin(a)]),inner=4.5*p.scale,outer=69.5*p.scale;
 const centers=p.centerDistances.map((d,i)=>d-p.centerWidths[[0,2,1,0,2,1][i]]),edges=p.outerDistances.map((d,i)=>d-p.outerWidths[i]);
 if([...centers,...edges].some(d=>!Number.isFinite(d)||d<=0))throw new RangeError('Delta object distances must exceed pillar widths');
 return [...xy.map(([x,y],i)=>({distance:centers[i],first:cal.stable([x*inner,y*inner,0]),second:cal.stable([x*outer,y*outer,0])})),...xy.map(([x,y],i)=>{const [dx,dy]=xy[(i+2)%6],sx=x*65*p.scale,sy=y*65*p.scale;return {distance:edges[i],first:cal.stable([sx+dx*inner,sy+dy*inner,0]),second:cal.stable([sx+dx*outer,sy+dy*outer,0])};})];
}
