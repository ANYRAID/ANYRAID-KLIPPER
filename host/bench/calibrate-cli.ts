import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {calibrationCliFixture} from '../contracts/calibration-fixtures.ts';
import {calibrationReference,verifyCalibrationInput} from '../test/helpers/calibration-reference.ts';
const dir=mkdtempSync(join(tmpdir(),'calibrate-cli-bench-')),input=join(dir,'input.csv'),script=fileURLToPath(new URL('../../scripts/calibrate_shaper.ts',import.meta.url));
try{
 const text=calibrationCliFixture();verifyCalibrationInput(text,calibrationReference.cli.inputSha256);writeFileSync(input,text);const times:number[]=[],reference=calibrationReference.cli.performance;
 for(let run=0;run<16;run++){const start=performance.now(),out=execFileSync(process.execPath,[script,'--shaper_freq','30:80:5','-c',join(dir,'output.csv'),input],{encoding:'utf8',maxBuffer:1024**2}),elapsed=performance.now()-start;assert.equal(out.match(/Recommended shaper is (.+)/)?.[1],reference.recommendation);if(run>=5)times.push(elapsed);}
 times.sort((a,b)=>a-b);assert(times[5]<=reference.python.medianMs*1.25+20);assert(times[10]<=reference.python.p95Ms*1.5+20);
 console.log(JSON.stringify({nodeVersion:process.version,warmups:5,runs:11,bins:256,frequencyRange:'30:80:5',recommendation:reference.recommendation,node:{medianMs:times[5],p95Ms:times[10]},historicalPython:reference.python,referenceCPU:calibrationReference.cpu,scope:'Full Node CLI including worker startup and CSV; fixed original recommendation and historical Python timing, not a new Python run. No plot encoding or physical timing.'},null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
