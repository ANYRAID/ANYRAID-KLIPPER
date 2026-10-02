import {readFile,writeFile,rename,unlink,realpath,stat,lstat,readlink} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
export async function generateKconfigOutput(mode:'header'|'minimal'|'full'='header'){
 const minimal=mode==='minimal',full=mode==='full';
 if(Number(process.versions.node.split('.')[0])!==26)throw new Error('Node.js 26 is required');
 const {values,positionals}=parseArgs({allowPositionals:true,options:{'header-path':{type:'string'},kconfig:{type:'string'},out:{type:'string'},help:{type:'boolean',short:'h'}}});
 if(values.help){console.log(full?'Usage: node scripts/kconfig-olddefconfig.mjs [src/Kconfig]\nUpdates KCONFIG_CONFIG (default .config), preserving its previous contents as .old.':minimal?'Usage: node scripts/kconfig-savedefconfig.mjs [--kconfig src/Kconfig] [--out defconfig]\nReads KCONFIG_CONFIG; honors KCONFIG_CONFIG_HEADER, CONFIG_ and srctree.':'Usage: node scripts/kconfig-genconfig.mjs [--header-path OUTPUT] [src/Kconfig]\nReads KCONFIG_CONFIG (default .config); honors KCONFIG_AUTOHEADER, KCONFIG_AUTOHEADER_HEADER, CONFIG_ and srctree.');return;}
 if(minimal?(positionals.length>0||values['header-path']!==undefined):(positionals.length>1||values.kconfig!==undefined||values.out!==undefined))throw new Error('Invalid Kconfig output arguments');
 if(full&&values['header-path']!==undefined)throw new Error('olddefconfig writes KCONFIG_CONFIG');
 const [{parseKconfig},{loadKconfigConfiguration,kconfigAutoconf,kconfigMinimal,kconfigFull}]=await Promise.all([
  import('./parser.ts'),import('./configuration.ts'),
 ]);
 const root=resolve(process.env.srctree||'.'),entry=minimal?(values.kconfig??'src/Kconfig'):(positionals[0]??'src/Kconfig');
 const input=resolve(process.env.KCONFIG_CONFIG??'.config'),output=full?input:resolve(minimal?(values.out??'defconfig'):(values['header-path']??process.env.KCONFIG_AUTOHEADER??'config.h'));
 if(!full&&input===output)throw new Error('Configuration input and output must differ');
 const tree=await parseKconfig(root,entry);
 if(tree.files.some(file=>resolve(root,file)===output))throw new Error('Output must not overwrite a Kconfig source');
 let source='',inputExists=false;
 let originalMode:number|undefined;
 try{source=new TextDecoder('utf-8',{fatal:true}).decode(await readFile(input));inputExists=true;if(full)originalMode=(await stat(input)).mode;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const {model,warnings}=loadKconfigConfiguration(tree,source,process.env.CONFIG_??'CONFIG_');
 for(const warning of warnings)console.error(input+': '+warning);
 const result=full?kconfigFull(tree,model,process.env.KCONFIG_CONFIG_HEADER??'',process.env.CONFIG_??'CONFIG_'):minimal?kconfigMinimal(model,process.env.KCONFIG_CONFIG_HEADER??'',process.env.CONFIG_??'CONFIG_'):kconfigAutoconf(model,process.env.KCONFIG_AUTOHEADER_HEADER??'',process.env.CONFIG_??'CONFIG_');
 try{if(await readFile(output,'utf8')===result)return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 // Preserve a configuration symlink while replacing its target atomically.
 const configDestination=async(path:string,depth=0):Promise<string>=>{
  if(depth>=40)throw new Error('Configuration symlink depth limit');
  try{return await realpath(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  try{if((await lstat(path)).isSymbolicLink())return configDestination(resolve(dirname(path),await readlink(path)),depth+1);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return path;
 };
 const destination=full?await configDestination(output):output;
 if(tree.files.some(file=>resolve(root,file)===destination))throw new Error('Output must not overwrite a Kconfig source');
 const atomic=async(path:string,data:string,fileMode?:number)=>{
  const temporary=path+'.'+randomUUID()+'.tmp';
  try{await writeFile(temporary,data,{flag:'wx',mode:fileMode});await rename(temporary,path);}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 };
 if(full&&inputExists)await atomic(output+'.old',source,originalMode);
 await atomic(destination,result,originalMode);
}
