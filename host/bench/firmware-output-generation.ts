import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const directory=mkdtempSync(join(tmpdir(),'output-firmware-bench-'));
try{
 const helpers=fileURLToPath(new URL('../test/helpers/output-firmware/',import.meta.url)),binary=join(directory,'bench');
 execFileSync(process.env.CC??'cc',['-std=gnu11','-O2','-Wall','-Wextra','-Werror','-Wno-unused-parameter','-I'+helpers,join(helpers,'test.c'),'-o',binary],{timeout:60000,stdio:'pipe'});
 const data:number[][]=JSON.parse(execFileSync(binary,['--bench'],{encoding:'utf8',timeout:30000}));
 const stats=(index:number)=>{const values=data.slice(2).map(row=>row[index]).sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};};
 console.log(JSON.stringify({warmups:2,samples:11,updates:100000,softwareLegacy:stats(0),hardwareLegacy:stats(1),softwareGeneration:stats(2),hardwareGeneration:stats(3),scope:'Actual C command and timer handlers on desktop, mocked GPIO, IRQ and timer scheduler, libc allocation. Both routes use current firmware. Not target-board interrupt latency or physical PWM.'},null,2));
}finally{rmSync(directory,{recursive:true,force:true});}
