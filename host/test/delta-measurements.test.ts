import test from 'node:test';
import assert from 'node:assert/strict';
import {DeltaCalibration,fitDeltaCalibration} from '../src/calibration/delta-calibration.ts';
import {deltaObjectDistances} from '../src/calibration/delta-measurements.ts';
import {asymmetricDeltaCalibration} from './helpers/delta-calibration.ts';
import {measuredDeltaObject} from './helpers/delta-object.ts';
test('printed Delta object order, asymmetric widths and scale preserve geometric endpoints',()=>{
 const input=asymmetricDeltaCalibration()[0],cal=new DeltaCalibration(input.geometry);
 for(const scale of [.5,1,1.25]){
  const widths=[3,4,5],outerWidths=[3,4,5,6,7,8],measurements={scale,centerWidths:widths,outerWidths,centerDistances:Array.from({length:6},(_,i)=>65*scale+widths[[0,2,1,0,2,1][i]]),outerDistances:outerWidths.map(w=>65*scale+w)},before=structuredClone(measurements),distances=deltaObjectDistances(measurements,input.geometry);
  assert.deepEqual(measurements,before);assert.equal(distances.length,12);
  distances.forEach((d,i)=>{assert.equal(d.distance,65*scale);const a=cal.position(d.first),b=cal.position(d.second);assert(Math.abs(Math.hypot(...a.map((v,j)=>v-b[j]))-65*scale)<1e-10);if(i<6)assert(Math.abs(Math.hypot(a[0],a[1])-4.5*scale)<1e-10);});
  const first=cal.position(distances[0].first);assert(first[0]<0&&first[1]<0);const north=cal.position(distances[4].first);assert(Math.abs(north[0])<1e-10&&north[1]>0);
 }
});
test('object measurements feed the extended solver and recover known geometry',()=>{
 const {input,truth,measurements}=measuredDeltaObject(),result=fitDeltaCalibration({...input,distances:deltaObjectDistances(measurements,input.geometry)});assert(result.search.converged);assert(result.heightResiduals.every(e=>Math.abs(e)<1e-7));assert(result.distanceResiduals.every(e=>Math.abs(e)<1e-7));
 const p=new DeltaCalibration(result.geometry).parameters(true).values;for(const [k,v] of Object.entries(truth.parameters(true).values))assert(Math.abs(p[k]-v)<1e-7);
 for(const bad of [{...measurements,scale:0},{...measurements,scale:Infinity},{...measurements,centerWidths:[1,2]},{...measurements,outerDistances:Array(6).fill(1)},{...measurements,centerDistances:Array(6).fill(NaN)},{...measurements,extra:1},{...measurements,scale:100}])assert.throws(()=>deltaObjectDistances(bad,input.geometry));
});
