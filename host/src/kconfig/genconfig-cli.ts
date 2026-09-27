import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
export async function generateKconfigOutput(minimal=false){
 if(Number(process.versions.node.split('.')[0])!==26)throw new Error('Node.js 26 is required');
 const {values,positionals}=parseArgs({allowPositionals:true,options:{'header-path':{type:'string'},kconfig:{type:'string'},out:{type:'string'},help:{type:'boolean',short:'h'}}});
 if(values.help){console.log(minimal?'Usage: node scripts/kconfig-savedefconfig.mjs [--kconfig src/Kconfig] [--out defconfig]\nReads KCONFIG_CONFIG; honors KCONFIG_CONFIG_HEADER, CONFIG_ and srctree.':'Usage: node scripts/kconfig-genconfig.mjs [--header-path OUTPUT] [src/Kconfig]\nReads KCONFIG_CONFIG (default .config); honors KCONFIG_AUTOHEADER, KCONFIG_AUTOHEADER_HEADER, CONFIG_ and srctree.');return;}
 if(minimal?(positionals.length>0||values['header-path']!==undefined):(positionals.length>1||values.kconfig!==undefined||values.out!==undefined))throw new Error('Invalid Kconfig output arguments');
 const [{parseKconfig},{loadKconfigConfiguration,kconfigAutoconf,kconfigMinimal}]=await Promise.all([
  import('./parser.ts'),import('./configuration.ts'),
 ]);
 const root=resolve(process.env.srctree||'.'),entry=minimal?(values.kconfig??'src/Kconfig'):(positionals[0]??'src/Kconfig');
 const input=resolve(process.env.KCONFIG_CONFIG??'.config'),output=resolve(minimal?(values.out??'defconfig'):(values['header-path']??process.env.KCONFIG_AUTOHEADER??'config.h'));
 if(input===output)throw new Error('Configuration input and output must differ');
 const tree=await parseKconfig(root,entry);
 if(tree.files.some(file=>resolve(root,file)===output))throw new Error('Output must not overwrite a Kconfig source');
 let source='';
 try{source=new TextDecoder('utf-8',{fatal:true}).decode(await readFile(input));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const {model,warnings}=loadKconfigConfiguration(tree,source,process.env.CONFIG_??'CONFIG_');
 for(const warning of warnings)console.error(input+': '+warning);
 const result=minimal?kconfigMinimal(model,process.env.KCONFIG_CONFIG_HEADER??'',process.env.CONFIG_??'CONFIG_'):kconfigAutoconf(model,process.env.KCONFIG_AUTOHEADER_HEADER??'',process.env.CONFIG_??'CONFIG_');
 try{if(await readFile(output,'utf8')===result)return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const temporary=output+'.'+randomUUID()+'.tmp';
 try{await writeFile(temporary,result,{flag:'wx'});await rename(temporary,output);}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
