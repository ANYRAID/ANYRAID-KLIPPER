import test from 'node:test';
import assert from 'node:assert/strict';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {GCodeMove} from '../src/gcode/move.ts';
import {ObjectCommands} from '../src/gcode/object-commands.ts';
function fixture(){let position=[0,0,0,0];const moves:number[][]=[],output:string[]=[],port={position:()=>position,move(p:readonly number[]){position=[...p];moves.push(position);}},coordinates=new GCodeMove(port),objects=new ObjectCommands(coordinates,port),dispatch=new GCodeDispatch({output:m=>output.push(m),shutdown(){}});objects.register(dispatch);for(const command of ['G1','M83','G92'])dispatch.register(command,c=>coordinates.execute(command,c.params));dispatch.setReady(true);return {port,coordinates,objects,dispatch,moves,output};}
test('slicer definitions retain sorted duplicate metadata and isolate status snapshots',async()=>{
 const f=fixture();await f.dispatch.execute('EXCLUDE_OBJECT_DEFINE NAME=b CENTER=1,2 POLYGON=[[0,0],[1,0],[1,1]] NOTE=kept\nEXCLUDE_OBJECT_DEFINE NAME=a\nEXCLUDE_OBJECT_DEFINE NAME=b\nEXCLUDE_OBJECT_START NAME=c\nEXCLUDE_OBJECT_END NAME=wrong\nEXCLUDE_OBJECT_DEFINE JSON=1');
 assert.deepEqual(f.objects.status.objects.map(o=>o.name),['A','B','B','C']);assert.deepEqual(f.objects.status.objects[1].center,[1,2]);assert.equal(f.objects.status.objects[1].NOTE,'kept');assert.equal(f.objects.status.current_object,null);assert(f.output.some(s=>s.includes('does not match')));assert(f.output.some(s=>s.includes('Known objects: [{')));
 f.objects.status.objects[0].name='mutated';assert.equal(f.objects.status.objects[0].name,'A');assert(f.coordinates.usesPort(f.port));
});
test('dispatch exclusion skips object motion and preserves travel, accounting and next file coordinates',async()=>{
 const f=fixture();f.coordinates.extrusionAccounting.setActive(true);
 await f.dispatch.execute('M83\nEXCLUDE_OBJECT_START NAME=a\nEXCLUDE_OBJECT CURRENT=1\nG1 E1\nG1 E1\nG1 E1\nG1 E1\nG1 E1\nG1 X20 E10\nEXCLUDE_OBJECT_END\nEXCLUDE_OBJECT_START NAME=b\nG1 X30 E1');
 assert.equal(f.moves.length,6);assert.deepEqual(f.moves.at(-1),[30,0,0,6]);assert.deepEqual(f.objects.status.excluded_objects,['A']);assert.equal(f.coordinates.state.position[3],16);
 f.objects.finish();assert(f.coordinates.usesPort(f.port));assert.equal(f.coordinates.state.position[3],6);assert.equal(f.objects.status.objects.length,2);
 f.objects.reset();assert.deepEqual(f.objects.status,{objects:[],excluded_objects:[],current_object:null});await f.dispatch.execute('G1 X40 E1');assert.deepEqual(f.moves.at(-1),[40,0,0,7]);
});
test('invalid metadata does not partially register objects; reset flags follow Python string semantics',async()=>{
 const f=fixture();for(const command of ['EXCLUDE_OBJECT_DEFINE NAME=bad CENTER=1','EXCLUDE_OBJECT_DEFINE NAME=bad POLYGON=[[1,2,3]]','EXCLUDE_OBJECT_DEFINE NAME=bad CENTER=1e999,0','EXCLUDE_OBJECT CURRENT=1'])await assert.rejects(f.dispatch.execute(command));assert.equal(f.objects.status.objects.length,0);
 await f.dispatch.execute('EXCLUDE_OBJECT_START NAME=a\nEXCLUDE_OBJECT NAME=a\nEXCLUDE_OBJECT RESET=0 NAME=a');assert.deepEqual(f.objects.status.excluded_objects,[]);await f.dispatch.execute('EXCLUDE_OBJECT_DEFINE RESET=0');assert(f.coordinates.usesPort(f.port));assert.equal(f.objects.status.objects.length,0);
});
