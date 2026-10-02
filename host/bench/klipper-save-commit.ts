import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {prepareKlipperSave} from '../src/config/klipper-save-preflight.ts';
import {commitKlipperSave} from '../src/config/klipper-save-commit.ts';
const dir=await mkdtemp(join(tmpdir(),'commit-bench-'));try{const path=join(dir,'printer.cfg');let current='[x]\na: original\n';await writeFile(path,current,{mode:0o600});const times:number[]=[];for(let i=0;i<16;i++){const p=(await prepareKlipperSave(path,current,{x:{a:`value${i}`}}))!;const start=performance.now(),result=await commitKlipperSave(p);if(i>=5)times.push(performance.now()-start);assert.equal(await readFile(result.backupPath,'utf8'),current);const actual=await readFile(path);assert.equal(actual.toString(),p.text);assert.equal(createHash('sha256').update(actual).digest('hex'),result.sha256);current=p.text;}times.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,commits:16,measured:11,medianMs:times[5],p95Ms:times[10],scope:'Real temporary-directory commits: exclusive lock, two source revalidations, raw backup, ownership/mode preservation, file sync and directory sync. Preparation and result-readback excluded from timing, all bytes verified. No Python speed ratio: original SAVE_CONFIG has different durability semantics. Filesystem cache/storage specific; no power-loss or hardware restart acceptance.'},null,2));}finally{await rm(dir,{recursive:true,force:true});}
