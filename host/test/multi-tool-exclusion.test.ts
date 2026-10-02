import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolMovePort} from '../src/gcode/tool-move.ts';
import {GCodeMove} from '../src/gcode/move.ts';
import {ObjectCommands} from '../src/gcode/object-commands.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
function fixture(){let physical=[0,0,0,0,0],reject=false;const moves:number[][]=[],port=new ToolMovePort({position:()=>physical,move(p){if(reject)throw Error('blocked');physical=[...p];moves.push([...p]);}},2,async()=>{}),coordinates=new GCodeMove(port),objects=new ObjectCommands(coordinates,port),dispatch=new GCodeDispatch({output(){},shutdown(){}});objects.register(dispatch);for(const c of ['G1','M83','M82','G92'])dispatch.register(c,x=>coordinates.execute(c,x.params));for(let i=0;i<2;i++)dispatch.register('T'+i,c=>port.select(i,coordinates,c.signal));dispatch.setReady(true);coordinates.extrusionAccounting.begin();return {dispatch,objects,coordinates,port,moves,get physical(){return physical;},set reject(v:boolean){reject=v;}};}
test('excluded extrusion stays with its physical tool across repeated switches and accounts only accepted filament',async()=>{
 const f=fixture();await f.dispatch.execute('M83\nEXCLUDE_OBJECT_START NAME=keep\nEXCLUDE_OBJECT NAME=skip\nG1 E1\nG1 E1\nG1 E1\nG1 E1\nG1 E1');assert.deepEqual(f.physical,[0,0,0,5,0]);
 await f.dispatch.execute('EXCLUDE_OBJECT_START NAME=skip\nG1 X10 E10\nT1\nG1 X20 E20');assert.deepEqual(f.physical,[0,0,0,5,0]);assert.equal(f.moves.length,5);
 await f.dispatch.execute('EXCLUDE_OBJECT_START NAME=keep\nG1 X30 E1');assert.deepEqual(f.physical,[30,0,0,5,1]);
 await f.dispatch.execute('T0\nG1 X40 E2');assert.deepEqual(f.physical,[40,0,0,7,1]);assert.equal(f.coordinates.extrusionAccounting.filamentUsed,8);
 f.objects.finish();assert.equal(f.port.hasObjectExclusion,false);assert.deepEqual(f.coordinates.state.position,[40,0,0,7]);assert.deepEqual(f.objects.status.excluded_objects,['SKIP']);
});
test('excluded retraction correction cannot move an inactive tool and late admission failure preserves retry state',async()=>{
 const f=fixture();await f.dispatch.execute('M83\nEXCLUDE_OBJECT NAME=skip\nG1 E1\nG1 E1\nG1 E1\nG1 E1\nG1 E1\nEXCLUDE_OBJECT_START NAME=skip\nG1 X10 E10\nG1 E-1\nT1\nG1 X20 E20\nG1 E-2');
 const before=[...f.physical];await f.dispatch.execute('EXCLUDE_OBJECT_START NAME=keep');f.reject=true;assert.throws(()=>f.coordinates.execute('G1',{X:30,E:3}),/blocked/);assert.deepEqual(f.physical,before);f.reject=false;
 f.coordinates.execute('G1',{X:30,E:3});assert.equal(f.physical[3],before[3]);assert.equal(f.physical[4],1);
 await f.dispatch.execute('T0\nG1 X40 E2');assert.equal(f.physical[3],6);assert.equal(f.physical[4],1);
 f.objects.reset();assert.deepEqual(f.objects.status,{objects:[],excluded_objects:[],current_object:null});assert.equal(f.port.hasObjectExclusion,false);
});
test('absolute origins and repeated reset never carry cancelled tool volume to another tool',async()=>{
 const f=fixture();await f.dispatch.execute('M83\nEXCLUDE_OBJECT NAME=skip\nG1 E1\nG1 E1\nG1 E1\nG1 E1\nG1 E1\nEXCLUDE_OBJECT_START NAME=skip\nG1 E100\nT1\nM82\nG92 E0\nG1 E50\nEXCLUDE_OBJECT_END\nG1 X1 E51');assert.deepEqual(f.physical,[1,0,0,5,1]);
 f.objects.reset();f.objects.reset();await f.dispatch.execute('T0\nG1 E1');assert.deepEqual(f.physical,[1,0,0,6,1]);
});
test('binary-fraction extrusion is conserved independently over 5000 mixed tool/object transitions',async()=>{
 const f=fixture();await f.dispatch.execute('M83\nEXCLUDE_OBJECT NAME=skip\nG1 E0.125\nG1 E0.125\nG1 E0.125\nG1 E0.125\nG1 E0.125');const expected=[.625,0];
 for(let i=0;i<5000;i++){const tool=Math.floor(i/7)%2,excluded=Math.floor(i/11)%2===1;await f.dispatch.execute('T'+tool+'\nEXCLUDE_OBJECT_START NAME='+(excluded?'skip':'keep')+'\nG1 X'+(i%30)+' E0.125');if(!excluded)expected[tool]+=.125;assert.deepEqual(f.physical.slice(3),expected);}
 assert.equal(f.coordinates.extrusionAccounting.filamentUsed,expected[0]+expected[1]);
});
