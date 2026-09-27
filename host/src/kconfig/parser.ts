import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {tokenizeKconfig,parseKconfigExpression,kconfigYes,type KExpression,type KToken} from './expression.ts';
export type KProperty={kind:'type';type:'bool'|'tristate'|'int'|'hex'|'string'}|{kind:'prompt';text:string;condition:KExpression}|{kind:'depends'|'visible';expression:KExpression}|{kind:'default';value:KExpression;condition:KExpression}|{kind:'select';name:string;condition:KExpression}|{kind:'imply';name:string;condition:KExpression}|{kind:'range';minimum:KExpression;maximum:KExpression;condition:KExpression}|{kind:'optional'};
export interface KNode{kind:'root'|'config'|'menuconfig'|'choice'|'menu'|'comment'|'if';name?:string;title?:string;file:string;line:number;properties:KProperty[];children:KNode[];help?:string;}
export interface KTree{root:KNode;files:string[];}
const indent=(s:string)=>s.match(/^\s*/)?.[0].replaceAll('\t','        ').length??0;
/** Parse the project Kconfig tree without evaluating defaults or user values.
 * Unsupported directives fail with file/line context, never silently disappear. */
export async function parseKconfig(rootDirectory:string,entry='src/Kconfig'):Promise<KTree>{
 const directory=await realpath(rootDirectory),root:KNode={kind:'root',file:entry,line:1,properties:[],children:[]},files:string[]=[],active=new Set<string>();let nodes=0,totalBytes=0;
 const read=async(path:string,parent:KNode):Promise<void>=>{
  const absolute=await realpath(resolve(directory,path)),name=relative(directory,absolute);if(name==='..'||name.startsWith('../')||isAbsolute(name))throw new Error('Kconfig source outside root');if(active.has(name)||active.size>=32||files.length>=128)throw new Error('Kconfig source cycle or capacity');
  const source=await readFile(absolute,'utf8');totalBytes+=Buffer.byteLength(source);if(totalBytes>8*1024*1024)throw new Error('Kconfig source byte limit');files.push(name);active.add(name);
  const stack=[parent],lines=source.split(/\r?\n/);let current=parent;
  const add=(kind:KNode['kind'],line:number,extra:Partial<KNode>={})=>{if(++nodes>16384)throw new Error('Kconfig node limit');const node:KNode={kind,file:name,line,properties:[],children:[],...extra};stack.at(-1)!.children.push(node);current=node;return node;};
  for(let line=0;line<lines.length;line++)try{
   const start=line,raw=lines[line];let text=raw;while(text.endsWith('\\')){if(++line>=lines.length)throw new Error('Dangling Kconfig continuation');text=text.slice(0,-1)+lines[line];}const tokens=tokenizeKconfig(text);if(!tokens.length)continue;
   const command=tokens.shift()!;if(command.kind!=='word')throw new Error('Expected Kconfig directive');const word=command.value;
   const exact=(n:number)=>{if(tokens.length!==n)throw new Error('Invalid '+word+' arguments');};
   const symbol=(t:KToken|undefined)=>{if(t?.kind!=='word'||!/^\w+$/.test(t.value))throw new Error('Expected symbol name');return t.value;};
   const quoted=(t:KToken|undefined)=>{if(t?.kind!=='string')throw new Error('Expected quoted text');return t.value;};
   const conditional=(values:readonly KToken[])=>{const at=values.findIndex(t=>t.kind==='word'&&t.value==='if');return {value:at<0?values:values.slice(0,at),condition:at<0?kconfigYes:parseKconfigExpression(values.slice(at+1))};};
   if(word==='source'){exact(1);const included=quoted(tokens[0]);if(included.includes('$'))throw new Error('Kconfig source expansion unsupported');await read(included,stack.at(-1)!);current=stack.at(-1)!;continue;}
   if(word==='mainmenu'){exact(1);if(stack.at(-1)!==root)throw new Error('Nested mainmenu');root.title=quoted(tokens[0]);continue;}
   if(['config','menuconfig'].includes(word)){exact(1);add(word as 'config'|'menuconfig',start+1,{name:symbol(tokens[0])});continue;}
   if(word==='choice'){if(tokens.length>1)throw new Error('Invalid choice');stack.push(add('choice',start+1,tokens.length?{name:tokens[0].kind==='string'?quoted(tokens[0]):symbol(tokens[0])}:{}));continue;}
   if(word==='menu'||word==='comment'){exact(1);const node=add(word,start+1,{title:quoted(tokens[0])});if(word==='menu')stack.push(node);continue;}
   if(word==='if'){const node=add('if',start+1);node.properties.push({kind:'depends',expression:parseKconfigExpression(tokens)});stack.push(node);continue;}
   if(['endif','endmenu','endchoice'].includes(word)){exact(0);if(stack.length===1||stack.at(-1)!.kind!==word.slice(3))throw new Error('Unmatched '+word);stack.pop();current=stack.at(-1)!;continue;}
   if(word==='help'){exact(0);let end=line+1;const content:string[]=[];while(end<lines.length&&(!lines[end].trim()||indent(lines[end])>indent(raw))){content.push(lines[end]);end++;}const nonempty=content.filter(s=>s.trim()),margin=nonempty.length?Math.min(...nonempty.map(indent)):0;current.help=content.map(s=>s.replaceAll('\t','        ').slice(margin)).join('\n').trimEnd();line=end-1;continue;}
   if(['bool','tristate','int','hex','string'].includes(word)){current.properties.push({kind:'type',type:word as 'bool'|'tristate'|'int'|'hex'|'string'});if(tokens.length){const {value,condition}=conditional(tokens);if(value.length!==1)throw new Error('Invalid type prompt');current.properties.push({kind:'prompt',text:quoted(value[0]),condition});}continue;}
   if(word==='depends'||word==='visible'){if(tokens.shift()?.value!==(word==='depends'?'on':'if'))throw new Error('Invalid '+word);current.properties.push({kind:word,expression:parseKconfigExpression(tokens)});continue;}
   if(word==='optional'){exact(0);current.properties.push({kind:'optional'});continue;}
   const {value,condition}=conditional(tokens);
   if(word==='prompt'){if(value.length!==1)throw new Error('Invalid prompt');current.properties.push({kind:'prompt',text:quoted(value[0]),condition});}
   else if(word==='default')current.properties.push({kind:'default',value:parseKconfigExpression(value),condition});
   else if(word==='select'||word==='imply'){if(value.length!==1)throw new Error('Invalid '+word);current.properties.push({kind:word,name:symbol(value[0]),condition});}
   else if(word==='range'){if(value.length!==2)throw new Error('Invalid range');current.properties.push({kind:'range',minimum:parseKconfigExpression(value.slice(0,1)),maximum:parseKconfigExpression(value.slice(1)),condition});}
   else throw new Error('Unsupported Kconfig directive '+word);
  }catch(error){throw new Error(name+':'+(line+1)+': '+(error instanceof Error?error.message:String(error)),{cause:error});}
  if(stack.length!==1)throw new Error(name+': unclosed '+stack.at(-1)!.kind);active.delete(name);
 };
 await read(entry,root);return {root,files};
}
