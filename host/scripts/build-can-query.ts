import {spawnSync} from 'node:child_process';
import {mkdirSync,renameSync,rmSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const host=fileURLToPath(new URL('..',import.meta.url)),include=process.env.NODE_INCLUDE??resolve(dirname(process.execPath),'../include/node');
const sanitizer=process.argv.includes('--address')?'address,undefined':process.argv.includes('--sanitize')?'undefined':null;
const output=resolve(host,`build/can-query${sanitizer===null?'':sanitizer==='undefined'?'-ubsan':'-asan'}.node`),temporary=output+'.tmp';mkdirSync(dirname(output),{recursive:true});
try{const result=spawnSync(process.env.CC??'cc',['-shared','-fPIC','-O2','-Wall','-Wextra','-Werror','-DNAPI_VERSION=8',`-I${include}`,resolve(host,'native/can-query.c'),'-lm',...sanitizer?[`-fsanitize=${sanitizer}`,'-fno-sanitize-recover=all','-fno-omit-frame-pointer','-g']:[],'-o',temporary],{stdio:'inherit',timeout:60000});if(result.status!==0)throw new Error(`CAN query build failed: ${result.error??result.status}`);renameSync(temporary,output);}finally{rmSync(temporary,{force:true});}
