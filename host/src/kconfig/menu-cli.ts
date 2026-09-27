import {createInterface} from 'node:readline';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {parseKconfig} from './parser.ts';
import {KconfigEditorFiles} from './editor-files.ts';
import type {KNode} from './parser.ts';
const safe=(text:string)=>text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,char=>'\\x'+char.charCodeAt(0).toString(16).padStart(2,'0'));
const commands='NUMBER: open/toggle/edit | back, root, next, prev | help [NUMBER]\nset NAME VALUE | search TEXT | all | save [PATH] | load PATH\nexport PATH: minimal config | reset | quit';
export async function runKconfigMenu():Promise<void>{
 const {values,positionals}=parseArgs({allowPositionals:true,options:{help:{type:'boolean',short:'h'}}});
 if(values.help){console.log('Usage: node scripts/kconfig-menuconfig.mjs [src/Kconfig]\n'+commands);return;}
 if(positionals.length>1)throw new Error('Expected one Kconfig path');
 const root=resolve(process.env.srctree||'.'),tree=await parseKconfig(root,positionals[0]??'src/Kconfig');
 const files=await KconfigEditorFiles.open(root,tree,resolve(process.env.KCONFIG_CONFIG??'.config'),process.env.CONFIG_??'CONFIG_',process.env.KCONFIG_CONFIG_HEADER??'');
 const rl=createInterface({input:process.stdin,output:process.stdout,terminal:!!(process.stdin.isTTY&&process.stdout.isTTY)});
 const lines=rl[Symbol.asyncIterator]();let interrupted=false,quit=false;
 rl.on('SIGINT',()=>{interrupted=true;rl.close();});
 const print=(message:string)=>process.stdout.write(safe(message)+'\n');
 const ask=async(message:string):Promise<string|undefined>=>{process.stdout.write(safe(message));const next=await lines.next();return next.done?undefined:next.value;};
 const confirm=async(message:string)=>(await ask(message+' [y/N] '))?.trim().toLowerCase()==='y';
 let parent:KNode=tree.root,query:string|undefined,showAll=false,page=0;
 const write=async(minimal:boolean,path?:string):Promise<boolean>=>{
  const target=path?resolve(path):files.path;
  const action=(overwrite=false)=>minimal?files.exportMinimal(target,overwrite):files.save(target,overwrite);
  try{await action();}catch(error){
   if(error instanceof Error&&error.message==='Destination exists: confirm overwrite'){
    if(!await confirm('Overwrite '+target+'?'))return false;
    await action(true);
   }else throw error;
  }
  print((minimal?'Exported minimal configuration: ':'Saved configuration: ')+target);return true;
 };
 try{
  for(const warning of files.editor.warnings)print('Warning: '+warning);
  print('Klipper firmware configuration — Node.js 26\n'+commands);
  while(!quit){
   const editor=files.editor;
   if(parent!==tree.root&&!editor.item(parent).visible&&!showAll){parent=tree.root;page=0;}
   const items=query===undefined?editor.items(parent,showAll):editor.search(query,showAll);
   page=Math.max(0,Math.min(page,Math.max(0,Math.ceil(items.length/20)-1)));
   print('\n'+(query===undefined?editor.path(parent).join(' / '):'Search: '+query)+(editor.dirty?' * unsaved':'')+(showAll?' [show all]':''));
   for(let i=page*20;i<Math.min(items.length,(page+1)*20);i++){
    const item=items[i],marker=item.kind==='menu'||item.kind==='choice'?'>':item.value===undefined?' ':item.type==='bool'||item.type==='tristate'?(item.value==='y'?'[y]':'[ ]'):JSON.stringify(item.value);
    print((i+1)+'. '+marker+' '+item.label+(item.name?' ('+item.name+')':'')+(item.visible?'':' [hidden]'));
   }
   print('Page '+(page+1)+'/'+Math.max(1,Math.ceil(items.length/20))+' — '+files.path);
   const input=await ask('menu> ');if(input===undefined)break;
   const command=input.trim();
   try{
    if(/^\d+$/.test(command)){
     const item=items[Number(command)-1];if(!item)throw new Error('No such item');
     if(item.kind==='menu'||item.kind==='choice'){parent=item.node;query=undefined;page=0;}
     else if(item.name&&item.value!==undefined){
      if(!item.visible)throw new Error('Item is hidden by dependencies');
      const isBoolean=item.type==='bool'||item.type==='tristate';
      if(isBoolean)editor.set(item.name,editor.parent(item.node)?.kind==='choice'?'y':item.value==='y'?'n':'y');
      else{const value=await ask(item.name+' value (literal text, empty allowed)> ');if(value!==undefined)editor.set(item.name,value);}
     }else print(editor.help(item.node));
    }else if(command==='back'){if(query!==undefined)query=undefined;else parent=editor.parent(parent)??tree.root;page=0;}
    else if(command==='root'){parent=tree.root;query=undefined;page=0;}
    else if(command==='next')page++;
    else if(command==='prev')page=Math.max(0,page-1);
    else if(command==='all'){showAll=!showAll;page=0;}
    else if(command==='help'||command==='?')print(commands);
    else if(/^help\s+\d+$/.test(command)){const item=items[Number(command.split(/\s+/)[1])-1];if(!item)throw new Error('No such item');print(editor.help(item.node));}
    else if(command.startsWith('search ')){query=command.slice(7).trim();page=0;}
    else if(command.startsWith('set ')){const match=/^set\s+(\S+)\s+(.*)$/.exec(input);if(!match)throw new Error('Use set NAME VALUE');editor.set(match[1],match[2]);}
    else if(command==='save'||command.startsWith('save '))await write(false,command.slice(4).trim()||undefined);
    else if(command.startsWith('export '))await write(true,command.slice(7).trim());
    else if(command.startsWith('load ')){
     if(!editor.dirty||await confirm('Discard unsaved changes and load?')){await files.load(command.slice(5).trim(),true);parent=tree.root;query=undefined;page=0;for(const warning of files.editor.warnings)print('Warning: '+warning);print('Loaded configuration: '+files.path);}
    }else if(command==='reset'){
     if(await confirm('Reset all options to defaults?')){editor.reset();parent=tree.root;query=undefined;page=0;}
    }else if(command==='quit'||command==='q'){
     if(!editor.dirty)quit=true;
     else{const answer=(await ask('Unsaved changes: [s]ave / [d]iscard / [c]ancel> '))?.trim().toLowerCase();if(answer==='d')quit=true;else if(answer==='s')quit=await write(false);}
    }else if(command)throw new Error('Unknown command; enter help for commands');
   }catch(error){print('Error: '+(error instanceof Error?error.message:String(error)));}
  }
 }finally{rl.close();}
 if(interrupted)process.exitCode=130;
 else if(!quit&&files.editor.dirty){print('Input closed; unsaved changes were not written.');process.exitCode=1;}
}
