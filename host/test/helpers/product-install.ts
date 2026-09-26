import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,readFile,access} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
const execute=promisify(execFile);
/** Fresh dependency tree from the emitted lockfile. No source node_modules link,
 * lifecycle scripts, development dependencies, Python or external PATH tools. */
export async function installProductDependencies(output:string):Promise<{durationMs:number;dependencies:number}>{
 await assert.rejects(lstat(join(output,'node_modules')),{code:'ENOENT'});
 const npm=process.env.npm_execpath??join(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js');
 await access(npm);
 const begin=performance.now(),env={...process.env,PATH:'/no-programs',NODE_OPTIONS:'--no-experimental-strip-types',NODE_PATH:'',NODE_DISABLE_COMPILE_CACHE:'1'};
 await execute(process.execPath,[resolve(npm),'ci','--omit=dev','--include=optional','--ignore-scripts','--no-audit','--no-fund'],{cwd:output,env,timeout:120000,maxBuffer:2*1024**2});
 const info=await lstat(join(output,'node_modules'));assert(info.isDirectory()&&!info.isSymbolicLink());
 for(const name of ['typescript','minijinja-js'])await assert.rejects(lstat(join(output,'node_modules',name)),{code:'ENOENT'});
 const project=JSON.parse(await readFile(join(output,'package.json'),'utf8'));
 for(const name of Object.keys(project.dependencies))assert(!(await lstat(join(output,'node_modules',name))).isSymbolicLink(),name+' must be independently installed');
 return {durationMs:performance.now()-begin,dependencies:Object.keys(project.dependencies).length};
}
