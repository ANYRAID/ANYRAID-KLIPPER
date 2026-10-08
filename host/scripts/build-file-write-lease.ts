import {spawnSync} from 'node:child_process';
import {mkdirSync,renameSync,rmSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const host=fileURLToPath(new URL('..',import.meta.url)),sanitizer=process.argv.includes('--address')?'address,undefined':process.argv.includes('--sanitize')?'undefined':null;
const output=resolve(host,`build/file-write-lease${sanitizer===null?'':sanitizer==='undefined'?'-ubsan':'-asan'}`),temporary=output+'.tmp';mkdirSync(dirname(output),{recursive:true});
// Only the Linux ASAN executable uses a fixed image layout: a private main
// witness diagnostic reproduced pre-main PIE failures. Keep both sanitizers
// and fail-fast behavior; leave the production executable's layout unchanged.
try{const result=spawnSync(process.env.CC??'cc',['-O2','-std=c11','-Wall','-Wextra','-Werror',resolve(host,'native/file-write-lease.c'),...sanitizer?[`-fsanitize=${sanitizer}`,'-fno-sanitize-recover=all','-fno-omit-frame-pointer','-g']:[],...sanitizer==='address,undefined'&&process.platform==='linux'?['-fno-pie','-no-pie']:[],'-o',temporary],{stdio:'inherit',timeout:60000});if(result.status!==0)throw new Error(`Write lease helper build failed: ${result.error??result.status}`);renameSync(temporary,output);}finally{rmSync(temporary,{force:true});}
