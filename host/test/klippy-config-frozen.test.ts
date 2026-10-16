import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {MoonrakerTemplateFactory} from '../src/moonraker/template-factory.ts';
import {readKlippyBinding} from '../src/moonraker/klippy-config.ts';
const bytes=await readFile(new URL('../contracts/moonraker-config-path-reference.json',import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),'1acad838310da914e1f8766eb9e8cf1799cf919f2ef063cf6aed26045d9d813d');
const reference=JSON.parse(bytes.toString()) as {graph:{directories:string[];files:string[];symlinks:Record<string,string>};cases:{name:string;source:string;output?:string;error?:string;parsed:{server:{path:string}}}[]};
for(const row of reference.cases)test('explicit Klippy context matches frozen upstream getpath: '+row.name,async()=>{
 const root=await mkdtemp(join(tmpdir(),'kp-')),config=new ConfigurationReader(new ConfigurationSource('/synthetic/config',{server:{klippy_uds_address:row.source}},[]));let owner:MoonrakerTemplateFactory|undefined;
 try{
  for(const dir of [...reference.graph.directories,'data'])await mkdir(join(root,dir),{recursive:true});for(const file of reference.graph.files)await writeFile(join(root,file),'synthetic');for(const [name,target]of Object.entries(reference.graph.symlinks))await symlink(target.replaceAll('$ROOT',root),join(root,name));
  await writeFile(join(root,'data','moonraker.secrets'),'{"ldap":{"password":"synthetic-private-template"}}');owner=await MoonrakerTemplateFactory.load(config,{dataPath:join(root,'data')});
  if(row.error)await assert.rejects(readKlippyBinding(config,{cwd:root,home:join(root,'home')}));
  else assert.equal((await readKlippyBinding(config,{cwd:root,home:join(root,'home')})).path,row.output!.replaceAll('$ROOT',root));
  assert.equal(owner.toJSON().templates,0);assert.equal(config.parsed().server.klippy_uds_address,row.parsed.server.path);assert(!JSON.stringify(config.snapshot()).includes('synthetic-private-template/file'));
 }finally{owner?.close();await rm(root,{recursive:true,force:true});}
});
