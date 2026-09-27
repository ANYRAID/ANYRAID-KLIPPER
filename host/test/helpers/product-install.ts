import assert from 'node:assert/strict';
import {lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
/** Fresh dependency tree from the emitted lockfile. No source node_modules link,
 * lifecycle scripts, development dependencies, Python or external PATH tools. */
export async function installProductDependencies(output:string):Promise<{durationMs:number;dependencies:number}>{
 await assert.rejects(lstat(join(output,'node_modules')),{code:'ENOENT'});
 const installed=await execute(process.execPath,['--no-experimental-strip-types',join(output,'scripts/product-install.js'),'--bundle',output],{env:{...process.env,PATH:'/no-programs',NODE_OPTIONS:'--no-experimental-strip-types',NODE_PATH:''},timeout:150000,maxBuffer:2*1024**2});
 const result=JSON.parse(installed.stdout) as {durationMs:number;dependencies:number};
 const info=await lstat(join(output,'node_modules'));assert(info.isDirectory()&&!info.isSymbolicLink());
 for(const name of ['typescript','minijinja-js'])await assert.rejects(lstat(join(output,'node_modules',name)),{code:'ENOENT'});
 const project=JSON.parse(await readFile(join(output,'package.json'),'utf8'));
 for(const name of Object.keys(project.dependencies))assert(!(await lstat(join(output,'node_modules',name))).isSymbolicLink(),name+' must be independently installed');
 return result;
}
