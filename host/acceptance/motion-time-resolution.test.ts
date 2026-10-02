import test from 'node:test';
import assert from 'node:assert/strict';
import {Move,motionLimits} from '../src/motion/lookahead.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
// Captured from product-host HTTP pause: valid short segment, not a large
// synthetic clock. Preserve this regression as part of product acceptance.
test('short deceleration from the product pause path is representable in the native queue',()=>{
 const move=new Move(motionLimits(100,1000),[3.78,0,0,0],[3.79,0,0,0],10);
 move.setJunction(100,100,80.00000000000007);
 const time=3.1993729999999587;
 using queue=new TrapQueue();
 assert.doesNotThrow(()=>queue.appendPlanned([move],time));
 const newest=queue.extract(1,time,time+1),position=newest[4]+newest[7]*(newest[2]+.5*newest[3]*newest[1])*newest[1];
 assert.ok(Math.abs(position-3.79)<=1e-12);
});
