import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseSDFlashArgs,runSDFlash} from '../src/diagnostics/sd-flash-cli.ts';
const signal=()=>new AbortController().signal;
test('CLI preserves defaults and validates board, baud and conflicting firmware arguments',()=>{
 const p=parseSDFlashArgs(['/dev/test','btt-skr-mini'],'/repo');assert.equal(p.mode,'flash');if(p.mode==='flash'){assert.equal(p.firmware,'/repo/out/klipper.bin');assert.equal(p.dictionary,'/repo/out/klipper.dict');assert.equal(p.baud,250000);}
 for(const args of [['-b','NaN','/dev/test','btt-skr-mini'],['/dev/test','missing'],['-f','a','/dev/test','btt-skr-mini','b']])assert.throws(()=>parseSDFlashArgs(args,'/repo'));
});
test('help and list do not acquire a device or read default firmware',async()=>{
 let text='';for(const flag of ['-h','-l'])assert.equal(await runSDFlash([flag],'/missing',signal(),t=>text+=t,async()=>{throw new Error('Unexpected device');}),0);assert.match(text,/Usage:/);assert.match(text,/btt-skr-mini/);
});
test('CLI reads bounded inputs, passes options and reports power cycle with exit 2',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sd-cli-'));try{const path=join(dir,'firmware.bin');await writeFile(path,Buffer.alloc(100,23));let calls=0,output='';const code=await runSDFlash(['-s','-b','115200','-f',path,'/dev/test','creality-v4.2.2'],dir,signal(),s=>output+=s,async(device,baud,r)=>{calls++;assert.equal(device,'/dev/test');assert.equal(baud,115200);assert.equal(r.fast,true);assert.equal(r.firmware.length,100);assert.match(r.timestamp!,/^\d{14}$/);return {state:'power-cycle-required',upload:{state:'uploaded',activationVerified:false,board:r.board,path:'firmware.bin',size:100,sha256:'a'.repeat(64),requiresPowerCycle:true,currentFirmwarePath:'FIRMWARE.CUR'}};});assert.equal(code,2);assert.equal(calls,1);assert.equal(JSON.parse(output).state,'power-cycle-required');await writeFile(path,'');await assert.rejects(runSDFlash(['-f',path,'/dev/test','btt-skr-mini'],dir,signal(),()=>{}),/size or type/);}finally{await rm(dir,{recursive:true,force:true});}
});
