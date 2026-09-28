import {ObjectExclusionTransform} from '../src/gcode/object-exclusion.ts';
import {MultiExtrusionObjectExclusion} from '../src/gcode/multi-extrusion-exclusion.ts';
const single:number[]=[],multi:number[]=[];
for(let round=0;round<8;round++)for(const dual of round%2?[true,false]:[false,true]){
 let physical=dual?[0,0,0,0,0]:[0,0,0,0],accepted=0;
 const port={position:()=>physical,move(p:readonly number[]){physical=[...p];accepted++;}},filter=dual?new MultiExtrusionObjectExclusion(port):new ObjectExclusionTransform(port),axis=dual?4:3;
 filter.exclude('skip');let expected=0;const start=performance.now();
 for(let i=0;i<100000;i++){const excluded=Math.floor(i/10)%2===1;if(excluded)filter.start('skip');else filter.end();const target=filter.position();target[axis]=(i+1)*.125;const receipt=filter instanceof MultiExtrusionObjectExclusion?filter.move(target,20,axis):filter.move(target,20);if(receipt.admitted)expected+=.125;}
 const elapsed=performance.now()-start;if(physical[axis]!==expected||dual&&physical[3]!==0||accepted!==50000)throw Error('Extrusion conservation failed');if(round>=3)(dual?multi:single).push(elapsed);
}
console.log(JSON.stringify({runtime:process.version,scope:'100000 exclusion-transform admissions, half excluded, second physical axis vs original single-extruder filter; alternating samples, excludes native planning/MCU IO',single:{samplesMs:single,medianMs:[...single].sort((a,b)=>a-b)[2]},multi:{samplesMs:multi,medianMs:[...multi].sort((a,b)=>a-b)[2]}},null,2));
