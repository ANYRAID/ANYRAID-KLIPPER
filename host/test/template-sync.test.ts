import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inspect} from 'node:util';
import {SecretsStore,parseSecretsText} from '../src/moonraker/secrets.ts';
import {MoonrakerTemplateOwner} from '../src/moonraker/template-owner.ts';
import {NativeTemplateCandidate} from '../src/moonraker/native-template.ts';
const reference=JSON.parse(await readFile(new URL('../contracts/moonraker-template-sync-reference.json',import.meta.url),'utf8')) as {secrets:string;file:string;cases:{name:string;source:string;context:string;output?:string;error?:string}[]};
function fixture(){const parsed=parseSecretsText(reference.secrets),secrets=new SecretsStore(reference.file,parsed.type,parsed.values);return {secrets,owner:new MoonrakerTemplateOwner(secrets)};}
for(const row of reference.cases)test('frozen upstream synchronous template: '+row.name,()=>{
 const {secrets,owner}=fixture();try{const template=owner.createTemplate(row.source);try{if(row.error)assert.throws(()=>template.render(row.context),/Error rendering private template/);else assert.equal(template.render(row.context),row.output);}finally{template.close();}}finally{owner.close();secrets.close();}
});
test('private template diagnostics and closure release references without exposing source, file or values',()=>{
 const {secrets,owner}=fixture(),template=owner.createTemplate('{secrets["ldap"]["password"]}');
 assert.equal(template.render(),'synthetic-private-template');
 for(const text of [JSON.stringify(owner),JSON.stringify(template),inspect(owner),inspect(template),JSON.stringify(secrets)])for(const privateText of ['synthetic-private-template','/synthetic/moonraker.secrets','secrets['])assert(!text.includes(privateText));
 secrets.close();assert.throws(()=>template.render(),/Secrets generation is closed/);owner.close();owner.close();template.close();template.close();assert.throws(()=>template.render(),/closed/);assert.throws(()=>owner.createTemplate('literal'),/closed/);
});
test('text failure discards partial output and remains reusable; resource limits do not publish private diagnostics',()=>{
 const {secrets,owner}=fixture();try{
  const template=owner.createTemplate('{secrets["ldap"]["password"]}{% if fail %}{raise_error("synthetic-private-template")}{% endif %}');
  for(let i=0;i<2;i++){try{template.render('{"fail":true}');assert.fail('expected error');}catch(error){assert.match(String(error),/Error rendering private template/);assert(!inspect(error).includes('synthetic-private-template'));}assert.equal(template.render(),'synthetic-private-template');}template.close();
  const limit=owner.createTemplate('{"x" * 65537}');assert.throws(()=>limit.render(),/Error rendering/);limit.close();
  const fuel=owner.createTemplate('{% for i in range(1000000) %}{% set j=i %}{% endfor %}');assert.throws(()=>fuel.render(),/Error rendering/);fuel.close();
  const context=owner.createTemplate('{large}');for(const text of ['[]','{"large":1e999}','{"large":170141183460469231731687303715884105728}'])assert.throws(()=>context.render(text),/Error rendering/);assert.equal(context.render('{"large":170141183460469231731687303715884105727}'),'170141183460469231731687303715884105727');context.close();
  assert.throws(()=>owner.createTemplate('\ud800'),/Invalid template/);assert.throws(()=>owner.createTemplate('x'.repeat(65537)),/resource limit/);
 }finally{owner.close();secrets.close();}
});
test('INI private values remain text and sensor typed side effects remain independent',()=>{
 const parsed=parseSecretsText('[section]\nvalue=1.0\n'),secrets=new SecretsStore('/synthetic/ini','ini',parsed.values),owner=new MoonrakerTemplateOwner(secrets);
 try{const text=owner.createTemplate('{secrets["section"]["value"] is string}/{secrets.get_type()}');assert.equal(text.render(),'True/ini');text.close();
  const sensor=new NativeTemplateCandidate('{% set v=payload|fromjson %}{set_result("i",v.i)}{set_result("f",v.f)}');try{assert.deepEqual(sensor.render('{"i":1,"f":1.0}').map(row=>[row.name,row.numberType,row.numberValue]),[['i','integer',1],['f','float',1]]);}finally{sensor.close();}
 }finally{owner.close();secrets.close();}
});
