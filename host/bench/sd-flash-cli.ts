import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../../scripts/flash-sdcard.ts',import.meta.url)),samples:number[]=[];
for(let i=0;i<9;i++){const start=performance.now(),result=spawnSync(process.execPath,[script,'-l'],{encoding:'utf8',timeout:10000});if(result.status!==0||!result.stdout.includes('btt-skr-mini'))throw new Error(result.stderr||'CLI failed');if(i>=2)samples.push(performance.now()-start);}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,warmups:2,samples:7,medianMs:samples[3],maxMs:samples[6],scope:'Fresh Node process and board listing; no device opened'},null,2));
