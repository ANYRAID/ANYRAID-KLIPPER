import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('actual thermocouple firmware signed range and faults under UBSan',()=>{
 const dir=mkdtempSync(join(tmpdir(),'thermocouple-firmware-'));
 try{const binary=join(dir,'test'),helpers=fileURLToPath(new URL('./helpers/',import.meta.url));execFileSync(process.env.CC??'cc',['-std=gnu11','-O2','-Wall','-Wextra','-Werror','-Wno-unused-parameter','-fsanitize=undefined','-fno-sanitize-recover=all','-I'+join(helpers,'output-firmware'),join(helpers,'thermocouple-firmware/test.c'),'-o',binary],{timeout:60000,stdio:'pipe'});assert.match(execFileSync(binary,{encoding:'utf8',timeout:10000}),/thermocouple firmware: passed/);}finally{rmSync(dir,{recursive:true,force:true});}
});
