import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildProductHost} from '../scripts/build-product-host.ts';
import {fatDisk} from './helpers/fatfs-disk.ts';
test('compiled SD CLI and bundled FatFs run without Python, TS loader or source checkout',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'sd-bundle-')),output=join(dir,'app');try{
  await buildProductHost(output);const record=JSON.parse(await readFile(join(output,'build-info.json'),'utf8'));
  for(const name of ['scripts/flash-sdcard.js','host/build/fatfs-helper','host/licenses/FatFs.txt','host/src/diagnostics/sd-boards.json'])assert.equal(createHash('sha256').update(await readFile(join(output,name))).digest('hex'),record.files[name]);
  const env={...process.env,PATH:'/no-programs',NODE_PATH:'',NODE_OPTIONS:'--no-experimental-strip-types'};const samples:number[]=[];
  for(let run=0;run<5;run++){const start=performance.now(),list=execFileSync(process.execPath,[join(output,'scripts/flash-sdcard.js'),'-l'],{env,cwd:dir,encoding:'utf8',timeout:10000});assert.match(list,/btt-skr-mini/);samples.push(performance.now()-start);}
  await writeFile(join(dir,'disk.bin'),fatDisk().image);const runner=join(dir,'verify.mjs');await writeFile(runner,`
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {FatFS} from ${JSON.stringify(pathToFileURL(join(output,'host/src/diagnostics/fatfs.js')).href)};
const image=await readFile(${JSON.stringify(join(dir,'disk.bin'))}),signal=new AbortController().signal,device={sectors:image.length/512,writeProtected:false,async readSector(n){return image.subarray(n*512,n*512+512);},async writeSector(n,data){image.set(data,n*512);},async sync(){}};
const bytes=Buffer.alloc(4097,23);let fs=await FatFS.mount(device,signal);
try{await fs.writeFile('firmware.bin',bytes,signal);await fs.close();fs=await FatFS.mount(device,signal);assert.deepEqual(await fs.readFile('firmware.bin',signal),bytes);}finally{await fs.close();}
console.log('compiled-fatfs-ok');
`);
  assert.match(execFileSync(process.execPath,[runner],{env,cwd:dir,encoding:'utf8',timeout:10000}),/compiled-fatfs-ok/);samples.sort((a,b)=>a-b);t.diagnostic(JSON.stringify({compiledCLI:{samples:5,medianMs:samples[2],maxMs:samples[4]},scope:'Bundled JS and native helper; PATH excludes Python and other programs; no physical SD device'}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
