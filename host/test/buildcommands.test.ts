import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dictionaryJSON,generateIdentify} from '../src/build/identify.ts';
import {toolArguments,buildToolVersions,formatBuildVersion} from '../src/build/build-version.ts';
import {buildCommands} from '../src/build/buildcommands.ts';
const request='DECL_COMMAND_FLAGS identify 0 identify offset=%u count=%c\n_DECL_ENCODER identify_response offset=%u data=%.*s\n';
test('identify uses Python ASCII escaping and Unicode scalar key order',()=>{
 assert.equal(dictionaryJSON({'😀':'中\x7f','\ue000':1,'10':2,'2':3}),'{"10":2,"2":3,"\\ue000":1,"\\ud83d\\ude00":"\\u4e2d\\u007f"}');
 const generated=generateIdentify({version:'运动\n',config:{CLOCK:50000000}});
 assert.equal(inflateSync(generated.compressed).toString(),generated.dictionary);
 assert.throws(()=>dictionaryJSON({v:Infinity}));assert.throws(()=>dictionaryJSON({v:0.1}));
});
test('build provenance parses quoted tools without shell expansion',async()=>{
 assert.deepEqual(toolArguments(`'/path with spaces/gcc' --flag="a b" '$HOME' x\\ y`),['/path with spaces/gcc','--flag=a b','$HOME','x y']);
 assert.deepEqual(toolArguments('"a\\$b" "" #literal'),['a\\$b','','#literal']);
 assert.throws(()=>toolArguments('"unterminated'));assert.throws(()=>toolArguments('trailing\\'));
 const outputs:Record<string,string>={gcc:'gcc (Toolchain) 12.3\n',as:'GNU assembler (Tools) 2.4\n',ld:'GNU ld (Tools) 2.4\n',bad:'invalid',mixed:'GNU ld (Tools) 2.5'};
 const run=async(args:string[])=>outputs[args[0]]??'';
 assert.deepEqual(await buildToolVersions('gcc;as;ld',run),{clean:true,toolstr:'gcc: (Toolchain) 12.3 binutils: (Tools) 2.4'});
 assert.equal((await buildToolVersions('gcc;as;mixed',run)).clean,false);
 assert.equal((await buildToolVersions('gcc;as;bad',run)).clean,false);
 const date=new Date(2026,8,20,1,2,3);
 assert.equal(formatBuildVersion('v1','', '-extra',true,date,'host'),'v1-extra');
 assert.equal(formatBuildVersion('v1-dirty','','',true,date,'host'),'v1-dirty-20260920_010203-host');
 assert.equal(formatBuildVersion('','archive','',true,date,'host'),'archive-20260920_010203-host');
});
test('whole generator rejects unknown declarations and normalizes Kconfig newlines',()=>{
 const out=buildCommands(request,'A=y\r\n',{version:'v',toolstr:'t'});
 assert.equal(JSON.parse(out.dictionary).kconfig,'A=y\n');
 assert.throws(()=>buildCommands('UNKNOWN x','',{version:'v',toolstr:'t'}),/Unknown/);
});
test('build CLI works without npm dependencies, preserves outputs on input errors',()=>{
 const dir=mkdtempSync(join(tmpdir(),'anyraid-build-cli-'));
 try {
  const input=join(dir,'requests file'),config=join(dir,'config file'),output=join(dir,'output.c'),dict=join(dir,'dictionary.json');
  writeFileSync(input,request);writeFileSync(config,'CONFIG_TEST=y\n');
  const entry=fileURLToPath(new URL('../../scripts/buildcommands.mts',import.meta.url));
  const run=()=>spawnSync(process.execPath,[entry,'-k',config,'-d',dict,input,output],{cwd:dir,encoding:'utf8',timeout:30000,maxBuffer:1048576});
  const good=run();assert.equal(good.status,0,good.stderr);assert.match(good.stdout,/Version: \?-/);
  const before=readFileSync(output);assert.equal(JSON.parse(readFileSync(dict,'utf8')).app,'Klipper');
  writeFileSync(input,'UNKNOWN x');const bad=run();assert.notEqual(bad.status,0);assert.deepEqual(readFileSync(output),before);
  const alias=spawnSync(process.execPath,[entry,'-k',config,input,input],{cwd:dir,encoding:'utf8',timeout:30000});assert.notEqual(alias.status,0);assert.match(alias.stderr,/distinct/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
