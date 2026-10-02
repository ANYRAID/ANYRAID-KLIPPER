import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {readSkewProfiles} from '../src/config/skew.ts';
import {linearMotionReader} from './helpers/linear-motion-config.ts';
import {validateNativePrinterSections} from '../src/config/native-printer-sections.ts';
const factors={xy:.01,xz:.02,yz:.03};
test('skew profiles require an owner, validate coefficients, and remain inert at startup',()=>{
 const reader=linearMotionReader({skew_correction:{},'skew_correction square':{xy_skew:'.01',xz_skew:'.02',yz_skew:'.03'}});
 const profiles=readSkewProfiles(reader)!;assert.deepEqual(profiles.square,factors);assert(Object.isFrozen(profiles));assert(Object.isFrozen(profiles.square));validateNativePrinterSections(reader);
 assert.equal(readSkewProfiles(linearMotionReader()),undefined);
 assert.throws(()=>readSkewProfiles(linearMotionReader({'skew_correction orphan':{}})),/require/);
 assert.throws(()=>readSkewProfiles(linearMotionReader({skew_correction:{xy_skew:'.1'}})),/options/);
 assert.throws(()=>readSkewProfiles(linearMotionReader({skew_correction:{},'skew_correction bad':{xy_skew:'nan',xz_skew:'0',yz_skew:'0'}})));
});
test('native skew survives physical rebases and mesh changes, clears without displacement',async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,undefined,false,false,false,undefined,undefined,undefined,false,undefined,undefined,0,true),signal=new AbortController().signal;
 try{
  assert.deepEqual(t.port.skewStatus,{configured:true,factors:{xy:0,xz:0,yz:0},revision:'0'});t.kinematics.markHomed([0,1,2]);
  await t.port.forcePosition([50,20,5,0],signal);await t.port.setSkew(factors,signal);assert.deepEqual(t.port.homingPosition(),[50,20,5,0]);assert.deepEqual(t.port.position(),[50+20*.01+5*.02,20+5*.03,5,0]);
  await t.port.forcePosition([51,30,5,0],signal);assert.deepEqual(t.port.position(),[51+30*.01+5*.02,30+5*.03,5,0]);assert.deepEqual(t.port.skewStatus.factors,factors);
  await t.port.replaceBedMesh(null,{},signal);assert.deepEqual(t.port.position(),[51+30*.01+5*.02,30+5*.03,5,0]);
  t.kinematics.markHomed([0,1,2]);t.port.move([51.41,30.15,5,0],5);await t.port.setSkew(undefined,signal);assert.equal(t.port.status.pendingMoves,0);assert.equal(t.port.skewStatus.revision,'2');assert.deepEqual(t.port.position(),t.port.homingPosition());assert(Math.abs(t.port.homingPosition()[0]-51.01)<1e-12);
 }finally{await t.close();}
});
