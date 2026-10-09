import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspect} from 'node:util';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {loadConfiguration,ConfigurationError} from '../src/moonraker/config-source.ts';
import {loadSecrets,parseSecretsText,type SecretValue} from '../src/moonraker/secrets.ts';

const reference=JSON.parse(await readFile(new URL('../contracts/moonraker-secrets-reference.json',import.meta.url),'utf8')) as {cases:{name:string;text:string;type:string;expected:unknown}[]};
function normalized(value:SecretValue):unknown{
 if(typeof value==='bigint')return {$exactInteger:value.toString()};
 if(typeof value==='number'&&Object.is(value,-0))return {$negativeZero:true};
 if(Array.isArray(value))return value.map(normalized);
 if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalized(item)]));
 return value;
}
for(const row of reference.cases)test('frozen upstream secrets format: '+row.name,()=>{
 if(row.type==='invalid')assert.throws(()=>parseSecretsText(row.text),ConfigurationError);
 else{const parsed=parseSecretsText(row.text);assert.equal(parsed.type,row.type);assert.deepEqual(normalized(parsed.values),row.expected);}
});
async function fixture(run:(dir:string,reader:(section?:string)=>Promise<ConfigurationReader>)=>Promise<void>){
 const directory=await mkdtemp(join(tmpdir(),'secrets-owner-'));
 try{await run(directory,async(section='')=>{const filename=join(directory,'moonraker.conf');await writeFile(filename,'[server]\n'+section);return new ConfigurationReader(await loadConfiguration(filename));});}
 finally{await rm(directory,{recursive:true,force:true});}
}
test('data-directory file wins and secret values never enter config snapshots or object inspection',()=>fixture(async(dir,makeReader)=>{
 const marker='synthetic-private-value';await writeFile(join(dir,'moonraker.secrets'),JSON.stringify({ldap:{password:marker}}));await writeFile(join(dir,'legacy.secrets'),'[ldap]\npassword=legacy');
 const reader=await makeReader('[secrets]\nsecrets_path: '+join(dir,'legacy.secrets')+'\n'),owner=await loadSecrets(reader,{dataPath:dir});
 try{assert.equal(owner.getType(),'json');assert.equal(owner.getFile(),join(dir,'moonraker.secrets'));assert.equal((owner.item('ldap') as Record<string,SecretValue>).password,marker);assert(reader.warnings().some(x=>x.includes('deprecated')));
  for(const text of [JSON.stringify(reader.snapshot()),JSON.stringify(owner),inspect(owner),JSON.stringify(reader.warnings())])assert(!text.includes(marker));
  assert.deepEqual(JSON.parse(JSON.stringify(owner)),{type:'json',closed:false});assert(!reader.validate().some(x=>x.startsWith('Unparsed')&&x.includes('secrets')));
 }finally{owner.close();}
}));
test('invalid selected default file does not silently load legacy credentials',()=>fixture(async(dir,makeReader)=>{
 await writeFile(join(dir,'moonraker.secrets'),'[invalid]\nsynthetic-private-value');await writeFile(join(dir,'legacy.secrets'),'[ldap]\npassword=legacy');
 const reader=await makeReader('[secrets]\nsecrets_path: '+join(dir,'legacy.secrets')+'\n'),owner=await loadSecrets(reader,{dataPath:dir});
 try{assert.equal(owner.getType(),'invalid');assert.equal(owner.get('ldap'),null);assert(!JSON.stringify(reader.warnings()).includes('synthetic-private-value'));assert(reader.warnings().some(x=>x.includes('Invalid secrets file')));}finally{owner.close();}
}));
test('legacy fallback, directory default and symlink target follow the selected-file contract',()=>fixture(async(dir,makeReader)=>{
 await mkdir(join(dir,'moonraker.secrets'));await writeFile(join(dir,'legacy.secrets'),'[DEFAULT]\nregion=example\n[ldap]\npassword=synthetic-value\n');await symlink('legacy.secrets',join(dir,'legacy-link.secrets'));
 const reader=await makeReader('[secrets]\nsecrets_path: '+join(dir,'legacy-link.secrets')+'\n'),owner=await loadSecrets(reader,{dataPath:dir});
 try{assert.equal(owner.getType(),'ini');assert.equal(owner.getFile(),join(dir,'legacy-link.secrets'));assert.deepEqual(normalized(owner.item('ldap')),{region:'example',password:'synthetic-value'});}finally{owner.close();}
}));
test('missing optional default is empty without warning, missing explicit legacy is diagnosed',()=>fixture(async(dir,makeReader)=>{
 const reader=await makeReader(),first=await loadSecrets(reader,{dataPath:dir});try{assert.equal(first.getType(),'invalid');assert.equal(first.get('absent','fallback'),'fallback');assert.deepEqual(reader.warnings(),[]);}finally{first.close();}
 const explicit=await makeReader('[secrets]\nsecrets_path: '+join(dir,'missing.secrets')+'\n'),second=await loadSecrets(explicit,{dataPath:dir});try{assert.equal(second.getType(),'invalid');assert(explicit.warnings().some(x=>x.includes('does not exist')));}finally{second.close();}
 const empty=await makeReader('[secrets]\nsecrets_path:\n'),third=await loadSecrets(empty,{dataPath:dir});try{assert.equal(third.getType(),'invalid');assert.equal(third.getFile(),process.cwd());assert(empty.warnings().some(x=>x.includes('does not exist')));}finally{third.close();}
}));
test('private generations are immutable and do not reread files; closure is idempotent',()=>fixture(async(dir,makeReader)=>{
 const filename=join(dir,'moonraker.secrets');await writeFile(filename,'{"value":{"nested":"before"},"large":9007199254740993}');const reader=await makeReader(),first=await loadSecrets(reader,{dataPath:dir});
 try{const value=first.item('value') as Record<string,SecretValue>;assert.throws(()=>{value.nested='mutated';});assert.equal(first.item('large'),9007199254740993n);assert.throws(()=>first.item('absent'),/not available/);
  await writeFile(filename,'{"value":{"nested":"after"}}');assert.equal(value.nested,'before');assert.equal((first.item('value') as Record<string,SecretValue>).nested,'before');
  const second=await loadSecrets(reader,{dataPath:dir});try{assert.equal((second.item('value') as Record<string,SecretValue>).nested,'after');}finally{second.close();}
 }finally{first.close();first.close();}
 assert.throws(()=>first.get('value'),/closed/);assert.throws(()=>first.item('value'),/closed/);assert.deepEqual(JSON.parse(JSON.stringify(first)),{type:'invalid',closed:true});
}));
test('parser and loader reject bounded-resource violations without exposing input',()=>fixture(async(dir,makeReader)=>{
 const marker='synthetic-private-value';for(const [text,options]of [
  [JSON.stringify({value:marker}),{bytes:8}],['{"value":{"nested":{"again":1}}}',{depth:1}],['{"a":1,"b":2}',{items:2}],['{"a":123456789}',{integerDigits:4}],['{"a":1e400}',{}],['{"a":"\\ud800"}',{}]
 ] as const)assert.throws(()=>parseSecretsText(text,options),error=>error instanceof ConfigurationError&&!error.message.includes(marker));
 assert.throws(()=>parseSecretsText('{}',{items:0}),/resource limit/);
 await writeFile(join(dir,'moonraker.secrets'),JSON.stringify({value:marker}));const reader=await makeReader();await assert.rejects(loadSecrets(reader,{dataPath:dir,bytes:8}),error=>error instanceof ConfigurationError&&!error.message.includes(marker));
 await writeFile(join(dir,'moonraker.secrets'),Buffer.from([255]));await assert.rejects(loadSecrets(reader,{dataPath:dir}),/Unable to read bounded/);
 await assert.rejects(loadSecrets(reader,{dataPath:'.'}),/absolute/);
}));
