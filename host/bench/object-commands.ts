import assert from 'node:assert/strict';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {GCodeMove} from '../src/gcode/move.ts';
import {ObjectCommands} from '../src/gcode/object-commands.ts';
const samples:number[]=[],lines=['EXCLUDE_OBJECT NAME=A'];
for(let i=0;i<1000;i++)lines.push('EXCLUDE_OBJECT_START NAME='+(['A','B'][i%2]),`G1 X${i%100} E${i/100} F600`,'EXCLUDE_OBJECT_END');
const script=lines.join('\n');let expected:number|undefined;
for(let run=0;run<24;run++){
 let physical=[0,0,0,0],count=0;const port={position:()=>physical,move(p:readonly number[]){physical=[...p];count++;}},coordinates=new GCodeMove(port),objects=new ObjectCommands(coordinates,port),dispatch=new GCodeDispatch({output(){},shutdown(){throw new Error('Benchmark shutdown');}});
 objects.register(dispatch);dispatch.register('G1',c=>coordinates.execute('G1',c.params));dispatch.setReady(true);
 const begin=performance.now();await dispatch.execute(script);const elapsed=performance.now()-begin;
 if(expected===undefined)expected=count;assert.equal(count,expected);assert.equal(count,503);assert.equal(objects.status.objects.length,2);if(run>=5)samples.push(elapsed);
}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,commands:lines.length,admittedMoves:expected,warmups:5,runs:samples.length,medianMs:samples[9],p95Ms:samples[18],scope:'Actual extended-command parsing, dispatch, object metadata and coordinate transform; in-memory port, no planner or hardware'},null,2));
