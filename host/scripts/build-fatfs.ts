import {spawnSync} from 'node:child_process';
import {mkdirSync,renameSync,rmSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const host=fileURLToPath(new URL('..',import.meta.url)),fat=resolve(host,'../lib/fatfs'),output=resolve(host,'build/fatfs-helper'),temporary=output+'.tmp';
mkdirSync(dirname(output),{recursive:true});
try{const run=spawnSync(process.env.CC??'cc',['-O2','-std=c11','-Wall','-Wextra','-Werror','-Wno-unused-parameter',...process.argv.includes('--sanitize')?['-fsanitize=undefined','-fno-sanitize-recover=all','-g']:[],`-I${fat}`,resolve(host,'native/fatfs-helper.c'),...['ff.c','ffsystem.c','ffunicode.c'].map(p=>resolve(fat,p)),'-o',temporary],{stdio:'inherit',timeout:60000});if(run.status!==0)throw new Error('FatFs helper build failed');renameSync(temporary,output);}finally{rmSync(temporary,{force:true});}
