import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
for(const sanitizer of ['undefined','address,undefined'])test(`actual firmware output handlers fence stale generations and preserve defaults (${sanitizer})`,()=>{
 // GCC ASan PIE repeatedly faults on this host; non-PIE retains all checks.
 const directory=mkdtempSync(join(tmpdir(),'output-firmware-'));
 try{
  const helpers=fileURLToPath(new URL('./helpers/output-firmware/',import.meta.url)),binary=join(directory,'test');
  execFileSync(process.env.CC??'cc',['-std=gnu11','-O2','-Wall','-Wextra','-Werror','-Wno-unused-parameter','-fsanitize='+sanitizer,'-fno-sanitize-recover=all',...(sanitizer.includes('address')?['-fno-pie','-no-pie']:[]),'-I'+helpers,join(helpers,'test.c'),'-o',binary],{timeout:60000,stdio:'pipe'});
  assert.match(execFileSync(binary,{encoding:'utf8',timeout:10000}),/generations: passed/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
