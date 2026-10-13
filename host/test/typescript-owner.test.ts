import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readlink,rm,readdir,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runTypeScript} from '../scripts/run-typescript.ts';
import {buildProductHost} from '../scripts/build-product-host.ts';
const supported=process.platform==='linux'&&['x64','arm64'].includes(process.arch);
const official=new URL('../node_modules/typescript/lib/getExePath.js',import.meta.url);
const nativeName='@typescript/typescript-'+process.platform+'-'+process.arch;
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'typescript-owner-')),pkg=join(root,'node_modules/typescript'),native=join(root,'node_modules',nativeName),binary=join(native,'lib/tsc');
 await mkdir(join(pkg,'lib'),{recursive:true});await mkdir(join(native,'lib'),{recursive:true});
 await writeFile(join(root,'package-lock.json'),JSON.stringify({packages:{'node_modules/typescript':{version:'7.0.2'},['node_modules/'+nativeName]:{version:'7.0.2'}}}));
 await writeFile(join(pkg,'package.json'),JSON.stringify({name:'typescript',version:'7.0.2',type:'module',bin:{tsc:'bin/tsc'}}));
 await writeFile(join(pkg,'lib/getExePath.js'),await readFile(official));
 await writeFile(join(native,'package.json'),JSON.stringify({name:nativeName,version:'7.0.2',exports:{'./package.json':'./package.json'}}));
 await writeFile(binary,'#!'+process.execPath+'\n'+String.raw`const fs=require('node:fs'),{spawn}=require('node:child_process');
const [mode,path]=process.argv.slice(2);
if(mode==='exit17'){process.stdout.write('out');process.stderr.write('err');process.exitCode=17;}
else if(mode==='signal')process.kill(process.pid,'SIGTERM');
else if(mode==='hold'){fs.writeFileSync(path,String(process.pid));setInterval(()=>{},1000);}
else if(mode==='overflow'){setInterval(()=>process.stdout.write(Buffer.alloc(8192)),1);}
else if(mode==='descendant-pipe'||mode==='descendant-detached-pipes'){
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:mode==='descendant-pipe'?['ignore','inherit','inherit']:'ignore'});
 fs.writeFileSync(path,String(child.pid));process.exit(0);
}else process.stdout.write('ok');
`);await chmod(binary,0o755);
 return {root,pkg,native,binary,close:()=>rm(root,{recursive:true,force:true})};
}
async function terminated(pid:number){
 try{const stat=await readFile('/proc/'+pid+'/stat','utf8');assert(['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]),'owned descendant remains alive');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
test('official resolver binds the locked platform executable, then joins real exit outcomes',{skip:!supported},async()=>{
 const f=await fixture();try{
  const ok=await runTypeScript(f.root,[],{timeoutMs:5000,maxBuffer:4096});assert.equal(ok.status,0);assert.equal(ok.stdout,'ok');assert.equal(ok.cleanupComplete,true);
  assert.equal(ok.execution?.binary,f.binary);assert.equal(ok.execution?.nativePackage,nativeName);assert.equal(ok.execution?.nativeVersion,'7.0.2');assert.equal(ok.execution?.sha256,createHash('sha256').update(await readFile(f.binary)).digest('hex'));
  for(const [mode,status,signal]of [['exit17',17,null],['signal',null,'SIGTERM']]as const){const r=await runTypeScript(f.root,[mode],{timeoutMs:5000,maxBuffer:4096});assert.equal(r.status,status);assert.equal(r.signal,signal);assert.equal(r.cleanupComplete,true);assert.equal(r.error,undefined);}
 }finally{await f.close();}
});
test('timeout, AbortSignal and output bounds kill and join the exact native group',{skip:!supported},async()=>{
 const f=await fixture();try{
  for(const mode of ['timeout','abort','overflow']){
   const path=join(f.root,mode+'.pid'),controller=new AbortController();
   const pending=runTypeScript(f.root,[mode==='overflow'?'overflow':'hold',path],{timeoutMs:mode==='timeout'?1000:5000,maxBuffer:4096,signal:controller.signal});
   if(mode==='abort'){
    const deadline=Date.now()+4000;while(Date.now()<deadline){try{await readFile(path);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,10));}
    controller.abort();
   }
   const r=await pending;assert.equal(r.error?.code,mode==='timeout'?'ETIMEDOUT':mode==='abort'?'ABORT_ERR':'ENOBUFS');assert.equal(r.signal,'SIGKILL');assert.equal(r.cleanupComplete,true);assert.equal(r.execution?.compilerGroupStopped,true);
   await terminated(r.execution!.compilerPid!);
  }
 }finally{await f.close();}
});
test('normal native exit cleans same-group descendants with inherited or closed pipes',{skip:!supported},async()=>{
 const f=await fixture();try{
  for(const mode of ['descendant-pipe','descendant-detached-pipes']){
   const path=join(f.root,mode+'.pid'),r=await runTypeScript(f.root,[mode,path],{timeoutMs:5000,maxBuffer:4096});
   assert.equal(r.status,0);assert.equal(r.error,undefined);assert.equal(r.cleanupComplete,true);await terminated(Number(await readFile(path,'utf8')));
  }
 }finally{await f.close();}
});
test('wrong package versions and non-regular executable are rejected before native launch',{skip:!supported},async()=>{
 for(const kind of ['typescript-version','native-version','platform-version','binary-mode','binary-fifo']){
  const f=await fixture();try{
   if(kind==='typescript-version')await writeFile(join(f.pkg,'package.json'),JSON.stringify({name:'typescript',version:'7.0.3',type:'module',bin:{tsc:'bin/tsc'}}));
   if(kind==='native-version')await writeFile(join(f.native,'package.json'),JSON.stringify({name:nativeName,version:'7.0.3',exports:{'./package.json':'./package.json'}}));
   if(kind==='platform-version')await writeFile(join(f.root,'package-lock.json'),JSON.stringify({packages:{'node_modules/typescript':{version:'7.0.2'},['node_modules/'+nativeName]:{version:'7.0.3'}}}));
   if(kind==='binary-mode')await chmod(f.binary,0o644);
   if(kind==='binary-fifo'){await rm(f.binary);execFileSync('mkfifo',[f.binary]);}
   const r=await runTypeScript(f.root,[],{timeoutMs:2000,maxBuffer:4096});assert.equal(r.status,1,kind);assert.equal(r.phase,'resolve');assert.equal(r.execution,undefined);assert.equal(r.cleanupComplete,true);
  }finally{await f.close();}
 }
});
test('resolution FIFO and lock capacity cannot hang the owning process',{skip:!supported},async()=>{
 for(const kind of ['package-fifo','native-package-fifo','lock-large']){
  const f=await fixture();try{
   const path=kind==='package-fifo'?join(f.pkg,'package.json'):kind==='native-package-fifo'?join(f.native,'package.json'):join(f.root,'package-lock.json');
   if(kind==='lock-large')await writeFile(path,' '.repeat(1024**2+1));else{await rm(path);execFileSync('mkfifo',[path]);}
   const start=performance.now(),r=await runTypeScript(f.root,[],{timeoutMs:1000,maxBuffer:4096});assert(r.error||r.status!==0);assert.equal(r.cleanupComplete,true);assert(performance.now()-start<4000);assert.equal(r.phase,'resolve');
  }finally{await f.close();}
 }
});
test('unconfirmed group cleanup settles as failure and retains product staging and lock',{skip:!supported},async()=>{
 const f=await fixture(),kill=process.kill;
 try{
  process.kill=((pid:number,signal?:string|number)=>{if(pid<0&&signal===0)throw Object.assign(new Error('Synthetic group observation denial'),{code:'EPERM'});return kill(pid,signal as NodeJS.Signals);})as typeof process.kill;
  const r=await runTypeScript(f.root,[],{timeoutMs:5000,maxBuffer:4096});assert.equal(r.error?.code,'COMPILER_JOIN_FAILED');assert.equal(r.cleanupComplete,false);
  const output=join(f.root,'app');await mkdir(output);const marker=JSON.stringify({schema:1,product:'anyraid-product-host',files:{'scripts/product-host.js':'unchanged'}});await writeFile(join(output,'build-info.json'),marker);
  let error:Error|undefined;try{await buildProductHost(output);}catch(cause){error=cause as Error;}
  assert(error);const record=JSON.parse(error.message.split('\nproductCompilerFailure=')[1]);assert.equal(record.cleanupComplete,false);assert.equal(record.errorCode,'COMPILER_JOIN_FAILED');
  assert.equal(record.retainedBuild.lock,output+'.lock');assert((await readdir(f.root)).some(p=>p.startsWith('.product-build-')));assert.equal(await readFile(join(output,'build-info.json'),'utf8'),marker);
 }finally{process.kill=kill;await f.close();}
});
test('actual Node runner and builder CLIs join native cancellation before exiting',{skip:!supported},async()=>{
 const host=fileURLToPath(new URL('..',import.meta.url)),root=await mkdtemp(join(tmpdir(),'typescript-cli-cancel-'));
 try{
  for(const [name,signal,expected]of [['run-typescript','SIGTERM',143],['build-product-host','SIGINT',130]]as const){
   const output=join(root,name),marker=JSON.stringify({schema:1,product:'anyraid-product-host',files:{'scripts/product-host.js':'unchanged'}});
   if(name==='build-product-host'){await mkdir(output);await writeFile(join(output,'build-info.json'),marker);}
   const child=spawn(process.execPath,[join(host,'scripts',name+'.ts'),...name==='run-typescript'?['-p',join(host,'tsconfig.json')]:[output]],{cwd:host,stdio:['ignore','pipe','pipe']});
   let stderr='';child.stdout.resume();child.stderr.on('data',chunk=>{stderr+=chunk;});
   const closed=new Promise<{status:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(status,signal)=>resolve({status,signal}));});
   const children=new Set<number>();let nativePid:number|undefined;
   const deadline=Date.now()+10000;
   try{
    while(Date.now()<deadline&&child.exitCode===null&&child.signalCode===null){
     const ids=(await readFile('/proc/'+child.pid+'/task/'+child.pid+'/children','utf8')).trim().split(/\s+/u).filter(Boolean).map(Number);
     for(const id of ids){children.add(id);try{const binary=await readlink('/proc/'+id+'/exe');if(binary.endsWith('/lib/tsc'))nativePid=id;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
     if(nativePid)break;await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert(nativePid,'Actual native compiler was not observed: '+stderr);child.kill(signal);
    const result=await Promise.race([closed,new Promise<never>((_resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('CLI cancellation did not join')),10000);timer.unref();})]);
    assert.equal(result.status,expected,stderr);assert.equal(result.signal,null);await terminated(nativePid);
    if(name==='build-product-host'){assert.equal(await readFile(join(output,'build-info.json'),'utf8'),marker);assert.equal((await readdir(root)).some(p=>p.startsWith('.product-build-')||p.endsWith('.lock')),false);}
   }finally{
    if(child.exitCode===null&&child.signalCode===null){
     for(const id of children)try{process.kill(-id,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
     child.kill('SIGKILL');await closed.catch(()=>{});
    }
   }
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
