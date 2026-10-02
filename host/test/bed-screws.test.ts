import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initialBedScrewsState,planBedScrews} from '../src/homing/bed-screws.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/bed-screws-reference.json',import.meta.url),'utf8'));
const plan=(fine=0)=>({coarse:[0,1,2].map(i=>({position:[i,0] as [number,number],name:String(i)})),fine:Array.from({length:fine},(_,i)=>({position:[i,1] as [number,number],name:String(i)})),horizontalHeight:5,contactHeight:0,travelSpeed:50,liftSpeed:5});
test('bed screw accept and adjusted transitions match every original coarse/fine state',()=>{
 for(const row of reference.rows){const previous=structuredClone(row.before),transition=planBedScrews(plan(row.fine),row.before,row.action,[0,0,0,1]);assert.deepEqual(transition.state,row.after);assert.deepEqual(row.before,previous);assert.equal(transition.moves.length,row.after.phase==='idle'?1:3);assert(transition.moves.every(m=>m.position[3]===1));}
});
test('bed screw travel lifts before XY and uses bounded positive speeds and immutable input',()=>{
 const p=[9,9,10,3],result=planBedScrews(plan(),initialBedScrewsState(),'start',p);assert.deepEqual(result.moves,[{position:[9,9,10,3],speed:5},{position:[0,0,10,3],speed:50},{position:[0,0,0,3],speed:5}]);assert.deepEqual(p,[9,9,10,3]);
 assert.throws(()=>planBedScrews({...plan(),contactHeight:5},initialBedScrewsState(),'start',p));assert.throws(()=>planBedScrews({...plan(),coarse:[]},initialBedScrewsState(),'start',p));assert.throws(()=>planBedScrews(plan(),initialBedScrewsState(),'accept',p));assert.throws(()=>planBedScrews(plan(),{phase:'fine',current:0,accepted:0},'accept',p));
});
