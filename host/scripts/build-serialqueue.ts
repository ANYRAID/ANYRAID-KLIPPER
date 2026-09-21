import {spawnSync} from 'node:child_process';
import {mkdirSync,renameSync,rmSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const host=fileURLToPath(new URL('..',import.meta.url)),include=process.env.NODE_INCLUDE??resolve(dirname(process.execPath),'../include/node');
const sanitizer=process.argv.includes('--address')?'address,undefined':process.argv.includes('--sanitize')?'undefined':null;
const output=resolve(host,`build/serialqueue${sanitizer===null?'':sanitizer==='undefined'?'-ubsan':'-asan'}.node`),temporary=output+'.tmp';
mkdirSync(dirname(output),{recursive:true});
const args=['-shared','-fPIC','-O2','-Wall','-Wextra','-DNAPI_VERSION=8',`-I${include}`,`-I${resolve(host,'../klippy/chelper')}`,resolve(host,'native/serialqueue.c'),resolve(host,'native/uart.c'),resolve(host,'native/can-transport.c'),...['serialqueue.c','msgblock.c','pyhelper.c','pollreactor.c'].map(p=>resolve(host,'../klippy/chelper',p)),'-lm','-pthread','-o',temporary];
if(sanitizer)args.push(`-fsanitize=${sanitizer}`,'-fno-sanitize-recover=all','-fno-omit-frame-pointer','-g');
try{const result=spawnSync(process.env.CC??'cc',args,{stdio:'inherit',timeout:60000});if(result.status!==0)throw new Error(`Serialqueue build failed: ${result.error??result.status}`);renameSync(temporary,output);}finally{rmSync(temporary,{force:true});}
