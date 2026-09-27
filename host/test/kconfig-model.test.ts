import {assertKconfigOracle} from './helpers/kconfig-reference.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseKconfig} from '../src/kconfig/parser.ts';
import {KconfigModel} from '../src/kconfig/model.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
test('42 firmware configurations with low-level options off/on match all Python values, visibility and output flags',async()=>{
 const r=JSON.parse(await readFile(new URL('../contracts/kconfig-model-reference.json',import.meta.url),'utf8'));
 for(const [file,digest] of Object.entries(r.files))assert.equal(createHash('sha256').update(await readFile(join(root,file))).digest('hex'),digest,file);
 await assertKconfigOracle(r);
 const tree=await parseKconfig(root);
 for(const c of r.cases){
  assert.equal(createHash('sha256').update(await readFile(join(root,c.file))).digest('hex'),c.sha256,c.file);
  const model=new KconfigModel(tree,new Map(Object.entries(c.assignments) as [string,string][]));
  assert.deepEqual([...model.symbols.keys()],r.names);
  for(let i=0;i<r.names.length;i++){
   const value=model.value(r.names[i]);
   assert.equal(value.type,r.types[i]);
   assert.deepEqual([value.text,value.tri,value.visibility,value.write],c.expected[i],c.file+' lowlevel='+c.lowlevel+' '+r.names[i]);
  }
 }
 assert.equal(r.cases.length,84);assert.equal(r.names.length,363);
});
async function fixture(source:string,run:(tree:Awaited<ReturnType<typeof parseKconfig>>)=>void){
 const directory=await mkdtemp(join(tmpdir(),'kconfig-model-'));
 try{await writeFile(join(directory,'Kconfig'),source);run(await parseKconfig(directory,'Kconfig'));}finally{await rm(directory,{recursive:true,force:true});}
}
test('range fallback, hidden user values and select override are preserved',async()=>{
 await fixture('config GATE\n bool "Gate"\nconfig NUMBER\n int "Number"\n range 0 29\n default 50\nconfig HIDDEN\n string\n default "hidden"\nconfig SELECTOR\n bool "Select"\n select TARGET\n default y\nconfig TARGET\n bool "Target"\n depends on GATE\nconfig HEX\n hex "Hex"\n default 0xff\n',tree=>{
  const model=new KconfigModel(tree,new Map([['NUMBER','40'],['HIDDEN','override'],['TARGET','n']]));
  assert.equal(model.value('NUMBER').text,'29');
  assert.equal(model.value('HIDDEN').text,'hidden');
  assert.deepEqual(model.value('TARGET'),{type:'bool',text:'y',tri:2,visibility:0,write:true});
  assert.equal(new KconfigModel(tree,new Map([['NUMBER','001']])).value('NUMBER').text,'001');
  assert.throws(()=>new KconfigModel(tree,new Map([['HEX','-1']])),/numeric/);
  assert.throws(()=>new KconfigModel(tree,new Map([['GATE','m']])),/bool/);
  assert.throws(()=>new KconfigModel(tree,new Map([['MISSING','y']])),/Unknown/);
 });
});
test('choice uses last requested visible member then defaults when selection is hidden',async()=>{
 await fixture('config GATE\n bool "Gate"\nchoice\n prompt "Choice"\n default B\nconfig A\n bool "A"\nconfig B\n bool "B"\nconfig C\n bool "C"\n depends on GATE\nendchoice\n',tree=>{
  for(const [assignments,selected] of [[[], 'B'],[[['A','y'],['B','y']], 'B'],[[['B','y'],['A','y']], 'A'],[[['A','y'],['C','y']], 'B']] as [ [string,string][],string][]){
   const model=new KconfigModel(tree,new Map(assignments));
   for(const name of ['A','B','C'])assert.equal(model.value(name).text,name===selected?'y':'n');
  }
 });
});
test('dependency cycles and unsupported module declarations fail explicitly',async()=>{
 await fixture('config A\n bool\n default B\nconfig B\n bool\n default A\n',tree=>assert.throws(()=>new KconfigModel(tree).resolve(),/dependency cycle/));
 await fixture('config MODULE\n tristate "Module"\n',tree=>assert.throws(()=>new KconfigModel(tree),/Tristate/));
});
