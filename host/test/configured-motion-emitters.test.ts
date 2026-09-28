import test from 'node:test';
import assert from 'node:assert/strict';
import {compileConfiguredMotionEmitters} from '../src/config/motion-emitters.ts';
import {configuredMotionFixture,generateConfiguredEmitter} from './helpers/configured-motion.ts';
import {inputShaper} from '../src/motion/shaper.ts';
test('motion descriptors inherit exact OIDs, physical membership, polarity and calibrated clocks',()=>{
 const f=configuredMotionFixture(),[x,e]=f.emitters();assert.equal(x.settings.oid,0);assert.equal(e.settings.oid,0);assert.equal(x.member,0);assert.equal(e.member,1);
 assert.equal(x.settings.invertDirection,true);assert.equal(x.settings.frequency,1000000.25);assert.equal(x.settings.timeOffset,.01);assert.equal(e.settings.frequency,999999.75);assert.equal(e.settings.timeOffset,.02);
 assert.equal(x.rotationDistance/x.stepsPerRotation,.0125);assert.deepEqual(e.pressureAdvance,{advance:.05,smoothTime:.04});assert.equal(e.shapers,undefined);assert.equal(x.pressureAdvance,undefined);assert.deepEqual(x.shapers?.x,inputShaper('mzv',40,.1));
 assert(Object.isFrozen(x.settings)&&Object.isFrozen(x.shapers?.x?.times));
});
test('configured filter and clock wiring produces byte-identical native pulses to explicit reference parameters',()=>{
 const f=configuredMotionFixture(),[x,e]=f.emitters();
 for(const [descriptor,reference] of [[x,{...x,settings:{frequency:1000000.25,timeOffset:.01,oid:0,maxError:25,queueStepTag:2,directionTag:3,invertDirection:true},shapers:{x:inputShaper('mzv',40,.1)}}],[e,{...e,settings:{frequency:999999.75,timeOffset:.02,oid:0,maxError:25,queueStepTag:2,directionTag:3,invertDirection:false},pressureAdvance:{advance:.05,smoothTime:.04}}]] as const){const actual=generateConfiguredEmitter(descriptor);assert.equal(actual.position,720n);assert.deepEqual(actual,generateConfiguredEmitter(reference));}
});
test('every emitter must be mapped exactly once and extrusion cannot share kinematic trapq',()=>{
 const f=configuredMotionFixture();assert.throws(()=>compileConfiguredMotionEmitters(f.reader,f.hardware,[{...f.requests[0],queueId:undefined as unknown as string},f.requests[1]]),/invalid queue/);for(const requests of [[],[f.requests[0],f.requests[0]],[f.requests[0],{...f.requests[1],emitter:'unknown'}],[f.requests[0],{...f.requests[1],queueId:'xyz'}]])assert.throws(()=>compileConfiguredMotionEmitters(f.reader,f.hardware,requests));
});
test('invalid filter limits fail before native allocation even for disabled shapers',()=>{
 for(const options of [{shaper_freq_x:'-1'},{shaper_type:'invalid'},{damping_ratio_x:'1'},{shaper_type:'mzv(2,.5)',shaper_freq_x:'0'}] as Record<string,string>[])assert.throws(()=>configuredMotionFixture(options).emitters());
 for(const options of [{pressure_advance:'-1'},{pressure_advance_smooth_time:'0'},{pressure_advance_smooth_time:'.201'}] as Record<string,string>[])assert.throws(()=>configuredMotionFixture({},options).emitters());
 assert.equal(configuredMotionFixture({shaper_freq_x:'0'}).emitters()[0].shapers?.x,undefined);
});
test('coupled and delta routing is copied while malformed solver geometry is rejected',()=>{
 const f=configuredMotionFixture();for(const mode of ['corexy+','corexy-','corexz+','corexz-','z'] as const)assert.equal(compileConfiguredMotionEmitters(f.reader,f.hardware,[{...f.requests[0],mode},f.requests[1]])[0].mode,mode);
 const mode={kind:'delta' as const,armLength:250,towerX:50,towerY:75},e=compileConfiguredMotionEmitters(f.reader,f.hardware,[{...f.requests[0],mode},f.requests[1]])[0];mode.armLength=1;assert.deepEqual(e.mode,{kind:'delta',armLength:250,towerX:50,towerY:75});
 assert.throws(()=>compileConfiguredMotionEmitters(f.reader,f.hardware,[{...f.requests[0],mode:{...mode,armLength:NaN}},f.requests[1]]));
});

test('carriage transforms are owned snapshots and cannot attach to extrusion or Delta',()=>{
 const f=configuredMotionFixture(),carriage={xScale:-1,xOffset:180,yScale:1,yOffset:0};
 const emitted=compileConfiguredMotionEmitters(f.reader,f.hardware,[{...f.requests[0],carriage},f.requests[1]]);carriage.xOffset=0;
 assert.equal(emitted[0].carriage!.xOffset,180);assert(Object.isFrozen(emitted[0].carriage));assert.equal(emitted[1].carriage,undefined);
 for(const requests of [[{...f.requests[0],carriage:{...carriage,xScale:NaN}},f.requests[1]],[f.requests[0],{...f.requests[1],carriage}],[{...f.requests[0],mode:{kind:'delta' as const,armLength:250,towerX:0,towerY:0},carriage},f.requests[1]]])assert.throws(()=>compileConfiguredMotionEmitters(f.reader,f.hardware,requests),/carriage/);
});
