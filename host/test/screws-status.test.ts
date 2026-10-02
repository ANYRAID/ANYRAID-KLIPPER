import test from 'node:test';
import assert from 'node:assert/strict';
import {ScrewsCalibrationStatus} from '../src/motion/screws-status.ts';
import {calculateScrewTilt} from '../src/motion/screws-tilt.ts';
import {NativeObjects} from '../src/moonraker/native-objects.ts';
test('screw object projection retains completed advice but clears it on new measurement and failure',()=>{
 const owner=new ScrewsCalibrationStatus(),objects=new NativeObjects(new Map([['screws_tilt_adjust',()=>owner.status]]),()=>1);
 assert.deepEqual(owner.status,{state:'idle',error:false,max_deviation:null,results:{}});
 owner.begin(0);const result=calculateScrewTilt([0,.1,.2],'CW-M3',undefined,0);owner.complete(result);result.results[0].z=100;
 const snapshot=objects.query({screws_tilt_adjust:null}).status.screws_tilt_adjust as any;assert.equal(snapshot.results.screw1.z,0);assert.equal(snapshot.error,true);assert.equal(snapshot.max_deviation,0);snapshot.results.screw1.z=200;assert.equal(owner.status.results.screw1.z,0);
 owner.begin();assert.deepEqual(owner.status,{state:'measuring',error:false,max_deviation:null,results:{}});owner.fail();assert.deepEqual(owner.status,{state:'failed',error:true,max_deviation:null,results:{}});
 assert.deepEqual(new ScrewsCalibrationStatus().status.results,{});
});
