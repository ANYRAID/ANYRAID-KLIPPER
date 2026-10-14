import {spawnSync} from 'node:child_process';
import {mkdirSync,renameSync,rmSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const host=fileURLToPath(new URL('..',import.meta.url)),output=resolve(host,'build/lmdb-read'),temporary=output+'.tmp';
mkdirSync(dirname(output),{recursive:true});
if(process.platform!=='linux'||!['x64','arm64'].includes(process.arch))throw new Error('LMDB snapshot helper requires Linux x64/arm64');
try{const result=spawnSync(process.env.CC??'cc',['-O2','-std=c11','-Wall','-Wextra','-pthread','-Wl,--wrap=open',resolve(host,'native/lmdb-read.c'),resolve(host,'native/lmdb/mdb.c'),resolve(host,'native/lmdb/midl.c'),'-o',temporary],{stdio:'inherit',timeout:60000});if(result.status!==0)throw new Error(`LMDB snapshot build failed: ${result.error??result.status}`);renameSync(temporary,output);}finally{rmSync(temporary,{force:true});}
