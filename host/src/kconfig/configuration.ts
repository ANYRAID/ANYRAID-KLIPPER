import {KconfigModel} from './model.ts';
import {kconfigInteger} from './evaluate.ts';
import type {KTree,KNode} from './parser.ts';

export function loadKconfigConfiguration(tree:KTree,source:string,prefix='CONFIG_'):{model:KconfigModel;warnings:string[];assignments:Map<string,string>;selections:Map<string,string>}{
 if(Buffer.byteLength(source)>8*1024*1024)throw new Error('Kconfig configuration byte limit');
 const definitions=new KconfigModel(tree),assignments=new Map<string,string>(),selections=new Map<string,string>(),warnings:string[]=[];
 for(const [index,raw] of source.split(/\r?\n/).entries()){
  const line=raw.trimEnd();if(line.length>65536)throw new Error('Kconfig configuration line limit');
  const warn=(message:string)=>warnings.push('line '+(index+1)+': '+message);
  let name:string|undefined,value:string|undefined,unset=false;
  if(line.startsWith(prefix)){
   const equal=line.indexOf('=',prefix.length);
   if(equal>prefix.length){name=line.slice(prefix.length,equal);value=line.slice(equal+1);}
  }else if(line.startsWith('# '+prefix)){
   const match=/^([^ ]+) is not set/.exec(line.slice(prefix.length+2));
   if(match){name=match[1];value='n';unset=true;}
  }
  if(name===undefined||value===undefined){if(line&&!line.trimStart().startsWith('#'))warn('ignored malformed assignment');continue;}
  const symbol=definitions.symbols.get(name);
  if(!symbol){warn('ignored unknown symbol '+name);continue;}
  if(unset&&symbol.type!=='bool'&&symbol.type!=='tristate')continue;
  if(symbol.type==='bool'){
   if(value[0]!=='y'&&value[0]!=='n'){warn('ignored invalid bool '+name);continue;}
   value=value[0];
  }else if(symbol.type==='string'){
   const match=/^"((?:\\.|[^"\\])*)"/.exec(value);
   if(!match){warn('ignored malformed string '+name);continue;}
   value=match[1].replace(/\\(.)/g,'$1');
  }else if(symbol.type==='int'||symbol.type==='hex'){
   const number=kconfigInteger(value,symbol.type==='int'?10:16);
   if(number===undefined||(symbol.type==='hex'&&number<0n)){warn('ignored invalid number '+name);continue;}
  }else{warn('ignored untyped symbol '+name);continue;}
  if(assignments.has(name))warn('repeated assignment '+name);
  assignments.delete(name);assignments.set(name,value);
  if(symbol.choice&&value==='y')selections.set(symbol.choice.id,name);
 }
 return {model:new KconfigModel(tree,assignments,selections),warnings,assignments,selections};
}

const escape=(text:string)=>text.replaceAll('\\','\\\\').replaceAll('"','\\"');
function configLine(model:KconfigModel,name:string,prefix:string):string{
 const value=model.value(name);if(!value.write)return '';
 if(value.type==='bool'||value.type==='tristate')return value.text==='n'?'# '+prefix+name+' is not set\n':prefix+name+'='+value.text+'\n';
 return prefix+name+'='+(value.type==='string'?'"'+escape(value.text)+'"':value.text)+'\n';
}
export function kconfigFull(tree:KTree,model:KconfigModel,header='',prefix='CONFIG_'):string{
 const chunks=[header],visited=new Set<string>();let afterEnd=false;
 const walk=(node:KNode)=>{
  if(node.kind==='config'||node.kind==='menuconfig'){
   const name=node.name!;
   if(!visited.has(name)){
    visited.add(name);const line=configLine(model,name,prefix);
    if(line){if(afterEnd){chunks.push('\n');afterEnd=false;}chunks.push(line);}
   }
  }
  const visible=(node.kind==='menu'||node.kind==='comment')&&model.nodeVisible(node);
  if(visible){chunks.push('\n#\n# '+node.title+'\n#\n');afterEnd=false;}
  for(const child of node.children)walk(child);
  if(visible&&node.kind==='menu'){chunks.push('# end of '+node.title+'\n');afterEnd=true;}
 };
 walk(tree.root);return chunks.join('');
}
export function kconfigMinimal(model:KconfigModel,header='',prefix='CONFIG_'):string{
 return header+model.minimalSymbols().map(name=>configLine(model,name,prefix)).join('');
}
/** Repository Kconfiglib intentionally emits disabled bools and hidden symbols. */
export function kconfigAutoconf(model:KconfigModel,header='',prefix='CONFIG_'):string{
 const chunks=[header];
 for(const name of model.symbols.keys()){
  const value=model.value(name);let text=value.text;
  if(value.type==='bool'||value.type==='tristate')chunks.push('#define '+prefix+name+(text==='m'?'_MODULE 1':text==='y'?' 1':' 0')+'\n');
  else if(value.type==='string')chunks.push('#define '+prefix+name+' "'+escape(text)+'"\n');
  else{
   if(value.type==='hex'&&!text.startsWith('0x')&&!text.startsWith('0X'))text='0x'+text;
   chunks.push('#define '+prefix+name+' '+(text||'0')+'\n');
  }
 }
 return chunks.join('');
}
