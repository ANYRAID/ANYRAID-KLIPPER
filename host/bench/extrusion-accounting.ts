import {execFileSync} from 'node:child_process';
import {writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {GCodeMove} from '../src/gcode/move.ts';
const directory=await mkdtemp(join(tmpdir(),'extrusion-bench-'));
try{
 const oldPath=join(directory,'move.mts');await writeFile(oldPath,execFileSync('git',['show','f7018855:host/src/gcode/move.ts']));
 const Old=(await import(pathToFileURL(oldPath).href)).GCodeMove as typeof GCodeMove;
 function run(variant:number,capture=false){let position=[0,0,0,0];const output:number[][]=[];const engine=new (variant?GCodeMove:Old)({position:()=>position,move(p,s){position=[...p];if(capture)output.push([...p,s]);}});if(variant)engine.extrusionAccounting.begin();engine.execute('M83');for(let i=0;i<10000;i++){engine.execute('G1',{X:i/100,E:i%3===0?-.001:.003,F:1200});if(i%100===0){engine.execute('M221',{S:80+i%40});engine.execute('G92',{E:0});}}return {output,position};}
 assert.deepEqual(run(0,true),run(1,true));const samples:number[][]=[[],[]];
 for(let i=0;i<26;i++)for(const variant of i%2?[1,0]:[0,1]){const start=performance.now();run(variant);if(i>=5)samples[variant].push(performance.now()-start);}
 const results=samples.map(values=>{values.sort((a,b)=>a-b);return {medianMs:values[10],p95Ms:values[19]};});const ratio=results[1].medianMs/results[0].medianMs;assert(ratio<1.15,JSON.stringify({results,ratio}));
 console.log(JSON.stringify({node:process.version,baseline:'f7018855',moves:10000,warmups:5,runs:21,results,ratio,maximumMedianRatio:1.15,exactCoordinatesAndSpeeds:true}));
}finally{await rm(directory,{recursive:true,force:true});}
