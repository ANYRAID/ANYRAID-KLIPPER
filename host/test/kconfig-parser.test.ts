import {assertKconfigOracle} from './helpers/kconfig-reference.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseKconfig,type KNode} from '../src/kconfig/parser.ts';
import {tokenizeKconfig,parseKconfigExpression,type KExpression} from '../src/kconfig/expression.ts';
const root=fileURLToPath(new URL('../../',import.meta.url)),expression=(s:string)=>parseKconfigExpression(tokenizeKconfig(s));
function normalized(e:KExpression):unknown{if(e.kind==='binary'){if(e.operator==='&&'||e.operator==='||'){const parts:unknown[]=[];const collect=(x:KExpression)=>{if(x.kind==='binary'&&x.operator===e.operator){collect(x.left);collect(x.right);}else parts.push(normalized(x));};collect(e);return [e.operator,...parts];}return [e.operator,normalized(e.left),normalized(e.right)];}if(e.kind==='not')return ['!',normalized(e.value)];return [e.kind,e.value];}
test('complete repository Kconfig properties match frozen Python structure',async()=>{
 const reference=JSON.parse(await readFile(new URL('../contracts/kconfig-structure-reference.json',import.meta.url),'utf8')),tree=await parseKconfig(root),rows:unknown[]=[];
 await assertKconfigOracle(reference);
 for(const [path,digest] of Object.entries(reference.files))assert.equal(createHash('sha256').update(await readFile(join(root,path))).digest('hex'),digest,'Kconfig fixture changed: '+path);
 const walk=(n:KNode)=>{if(!['root','if'].includes(n.kind)){const prompt=n.properties.find(p=>p.kind==='prompt');rows.push({kind:n.kind,name:n.name??null,file:n.file,line:n.line,prompt:prompt?.kind==='prompt'?[prompt.text,normalized(prompt.condition)]:n.title?[n.title,normalized(expression('y'))]:null,help:n.help??null,defaults:n.properties.filter(p=>p.kind==='default').map(p=>[normalized(p.value),normalized(p.condition)]),selects:n.properties.filter(p=>p.kind==='select').map(p=>[p.name,normalized(p.condition)]),ranges:n.properties.filter(p=>p.kind==='range').map(p=>[normalized(p.minimum),normalized(p.maximum),normalized(p.condition)])});}n.children.forEach(walk);};walk(tree.root);
 const expected=reference.rows.map((r:any)=>({...r,prompt:r.prompt?[r.prompt[0],normalized(expression(r.prompt[1]))]:null,defaults:r.defaults.map((v:string[])=>v.map(x=>normalized(expression(x)))),selects:r.selects.map(([n,c]:string[])=>[n,normalized(expression(c))]),ranges:r.ranges.map((v:string[])=>v.map(x=>normalized(expression(x))))}));
 const order=(a:any,b:any)=>a.file.localeCompare(b.file)||a.line-b.line;assert.deepEqual(rows.sort(order),expected.sort(order));assert.equal(tree.files.length,12);assert.equal(rows.length,487);
});
test('expression precedence, quoted comments and malformed input',()=>{
 assert.deepEqual(normalized(expression('!A || B && C = "x#y"')),['||',['!',['symbol','A']],['&&',['symbol','B'],['=',['symbol','C'],['literal','x#y']]]]);
 for(const value of ['A &&','(A','A B','A = B = C','"bad','A & B','(A ")"','A "&&" B','A "||" B'])assert.throws(()=>expression(value));
});
test('source cycles, unmatched blocks and unknown directives fail explicitly',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kconfig-parser-'));try{for(const content of ['source "Kconfig"','choice\n','endif','unknown value']){await writeFile(join(dir,'Kconfig'),content);await assert.rejects(parseKconfig(dir,'Kconfig'));}}finally{await rm(dir,{recursive:true,force:true});}
});
test('nested dependencies, types and conditional properties remain attached to their owners',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kconfig-parser-'));
 try{
  await writeFile(join(dir,'Kconfig'),'if BOARD\nchoice "Address"\n bool "Address"\n depends on READY\nconfig VALUE\n hex "Value" if ENABLED\n default 0x10 if FALLBACK\n range 0 29\nendchoice\nendif\n');
  const tree=await parseKconfig(dir,'Kconfig');
  const conditional=tree.root.children[0],choice=conditional.children[0],value=choice.children[0];
  assert.deepEqual(conditional.properties,[{kind:'depends',expression:expression('BOARD')}]);
  assert.equal(choice.name,'Address');
  assert.deepEqual(choice.properties,[{kind:'type',type:'bool'},{kind:'prompt',text:'Address',condition:expression('y')},{kind:'depends',expression:expression('READY')}]);
  assert.deepEqual(value.properties,[{kind:'type',type:'hex'},{kind:'prompt',text:'Value',condition:expression('ENABLED')},{kind:'default',value:expression('0x10'),condition:expression('FALLBACK')},{kind:'range',minimum:expression('0'),maximum:expression('29'),condition:expression('y')}]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
