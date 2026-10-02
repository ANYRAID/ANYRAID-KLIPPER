import test from 'node:test';
import assert from 'node:assert/strict';
import {BedMeshFade} from '../src/motion/bed-mesh-fade.ts';
test('fade boundaries, tool offsets and signed corrections preserve inverse positions',()=>{
 for(const toolOffset of [-2,0,3])for(const target of [-.1,0,.1]){const fade=new BedMeshFade({start:1,end:10,target,toolOffset});assert.equal(fade.factor(1-toolOffset),1);assert.equal(fade.factor(10-toolOffset),0);assert.equal(fade.factor(5.5-toolOffset),.5);for(const meshZ of [-.3,0,.4])for(const z of [-3,0,.9,1,1.1,5,9.9,10,10.1,30])assert.ok(Math.abs(fade.unapply(fade.apply(z,meshZ),meshZ)-z)<1e-12);}
});
test('disabled fade keeps full correction without the legacy finite-height sentinel',()=>{const fade=new BedMeshFade({start:1,end:0,target:5});assert.equal(fade.target,0);assert.equal(fade.factor(3e9),1);assert.equal(fade.apply(5,.2),5.2);assert.equal(fade.unapply(5.2,.2),5);});
test('fade rejects invalid and ambiguous arithmetic',()=>{assert.throws(()=>new BedMeshFade({start:0,end:Infinity,target:0}));assert.throws(()=>new BedMeshFade({start:-1e308,end:1e308,target:0}));const f=new BedMeshFade({start:0,end:1,target:0});assert.throws(()=>f.factor(NaN));assert.throws(()=>f.apply(0,Infinity));assert.throws(()=>f.unapply(.5,1),/Noninvertible/);assert.throws(()=>f.unapply(.5,2),/Noninvertible/);});
