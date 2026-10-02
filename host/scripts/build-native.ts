import {spawnSync} from 'node:child_process';
import {mkdirSync,renameSync,rmSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const host=fileURLToPath(new URL('..',import.meta.url));
const sanitize=process.argv.includes('--sanitize');
const address=process.argv.includes('--address');
const output=resolve(host,address?'build/trapq-asan.node':sanitize?'build/trapq-ubsan.node':'build/trapq.node'),temporary=output+'.tmp';
mkdirSync(dirname(output),{recursive:true});
const include=process.env.NODE_INCLUDE??resolve(dirname(process.execPath),'../include/node');
const args=['-shared','-fPIC','-O2','-Wall','-Wextra','-DNAPI_VERSION=8',`-I${include}`,`-I${resolve(host,'../klippy/chelper')}`,`-I${resolve(host,'../src')}`,resolve(host,'native/trapq.c'),resolve(host,'../klippy/chelper/trapq.c'),'-lm','-o',temporary];
if(sanitize||address)args.push(address?'-fsanitize=address,undefined':'-fsanitize=undefined','-fno-sanitize-recover=all','-fno-omit-frame-pointer','-g');
try {
  const result=spawnSync(process.env.CC??'cc',args,{stdio:'inherit',timeout:60000});
  if(result.status!==0)throw new Error(`Native build failed: ${result.error??result.status}`);
  renameSync(temporary,output);
} finally {rmSync(temporary,{force:true});}
