import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cpus,loadavg} from 'node:os';
import assert from 'node:assert/strict';
const run=promisify(execFile),root=fileURLToPath(new URL('../../',import.meta.url));
const output=resolve(process.argv[2]??'/tmp/anyraid-motion-report-ab');await mkdir(output,{recursive:true});
const sequence=['off','on','on','off'] as const,results:Record<string,any>[]=[];
for(const [index,mode] of sequence.entries()){
 const before=loadavg(),started=new Date().toISOString();
 console.log(JSON.stringify({run:index+1,mode,phase:'started'}));
 const args=['--test','--test-isolation=none','--test-concurrency=1','--test-name-pattern=^nativeAuthorization=true apiLoad=true','host/acceptance/product-compiled-journey.test.ts'];
 let stdout:string,stderr:string;
 try{({stdout,stderr}=await run(process.execPath,args,{cwd:root,env:{...process.env,ANYRAID_BENCH_MOTION_REPORT:mode},maxBuffer:4*1024*1024}));}
 catch(error){const failed=error as {stdout?:string;stderr?:string};await writeFile(join(output,`${index+1}-${mode}.log`),(failed.stdout??'')+(failed.stderr??''));throw error;}
 await writeFile(join(output,`${index+1}-${mode}.log`),stdout+stderr);
 const line=stdout.split('\n').find(line=>line.includes('"bundleManifestSha256"'));assert(line,'Missing compiled metrics');const metrics=JSON.parse(line.slice(line.indexOf('{')));
 assert.equal(metrics.motionReportLoad,mode==='on');assert.equal(metrics.uploads,16);assert(metrics.minimumStepLeadMs>0);
 if(results.length)assert.equal(metrics.bundleManifestSha256,results[0].metrics.bundleManifestSha256,'A/B must use the identical product artifact');
 results.push({run:index+1,mode,started,loadBefore:before,loadAfter:loadavg(),metrics});
 await writeFile(join(output,'result.json'),JSON.stringify({node:process.version,cpu:cpus()[0]?.model,sequence,scope:'Same product and fixture; only repeated object-query payload changes. Two samples per mode, not a target-board or Python comparison.',results},null,2)+'\n');
 console.log(JSON.stringify({run:index+1,mode,statusP99Ms:metrics.statusP99Ms,minimumStepLeadMs:metrics.minimumStepLeadMs,phase:'passed'}));
}
