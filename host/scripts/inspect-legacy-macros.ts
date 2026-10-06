// GPL-3.0-or-later. Read-only inventory; never renders templates or opens devices.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {inspectKlipperConfiguration} from '../src/config/klipper-files.ts';

const sha=(data:Uint8Array|string)=>createHash('sha256').update(data).digest('hex');
const args=process.argv.slice(2),output=args.shift();
if(!output||!args.length)throw new Error('Usage: node scripts/inspect-legacy-macros.ts OUTPUT.json CONFIG.zip [...]');
const temporary=process.env.TMPDIR;
if(!temporary||!isAbsolute(temporary))throw new Error('Set TMPDIR to an owned temporary directory');
const root=await mkdtemp(join(temporary,'anyraid-macro-inventory-'));
const packages=[];
try{
 for(let index=0;index<args.length;index++){
  const archive=resolve(args[index]),bytes=await readFile(archive);
  if(bytes.length>8*1024*1024)throw new RangeError('Archive byte limit exceeded');
  const members=execFileSync('unzip',['-Z1',archive],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024}).trim().split('\n');
  if(members.length>256||new Set(members).size!==members.length)throw new Error('Archive member limit or duplicate member');
  const cfg=members.filter(name=>name.endsWith('.cfg'));
  const primary=cfg.filter(name=>basename(name)==='printer.cfg');
  if(primary.length!==1)throw new Error('Archive must contain exactly one primary printer.cfg');
  const directory=join(root,String(index));await mkdir(directory);
  let extracted=0;
  for(const member of cfg){
   if(!/^[A-Za-z0-9_./-]+$/.test(member)||member.startsWith('/')||member.split('/').some(part=>part==='..'||part==='.'||!part))throw new Error('Unsafe config archive member');
   const data=execFileSync('unzip',['-p',archive,member],{timeout:10000,maxBuffer:8*1024*1024});
   extracted+=data.length;if(extracted>8*1024*1024)throw new RangeError('Extracted config byte limit exceeded');
   // Keep includes inside this archive. Reject rather than rewrite unsafe paths.
   for(const line of data.toString('utf8').split(/\r?\n/)){
    const include=line.split('#',1)[0].match(/^\[include\s+(.+)\]/)?.[1].trim();
    if(include&&(isAbsolute(include)||include.includes('\\')||include.split('/').includes('..')))throw new Error('Include escapes archive');
   }
   const target=join(directory,member);await mkdir(dirname(target),{recursive:true});await writeFile(target,data,{flag:'wx',mode:0o600});
  }
  const inspection=await inspectKlipperConfiguration(join(directory,primary[0]));
  const definitions=new Map<string,{file:string;line:number}[]>();
  for(const file of inspection.source.files){
   const lines=(await readFile(file.filename,'utf8')).split(/\r?\n/);
   for(let line=0;line<lines.length;line++){
    const section=lines[line].split('#',1)[0].match(/^\[(gcode_macro\s+[^\]]+|delayed_gcode\s+[^\]]+)\]/)?.[1];
    if(section){const existing=definitions.get(section)??[];existing.push({file:relative(directory,file.filename),line:line+1});definitions.set(section,existing);}
   }
  }
  const macros=Object.entries(inspection.source.original).filter(([name])=>/^(gcode_macro|delayed_gcode) /.test(name)).map(([section,options])=>{
   const body=options.gcode??'',commands=new Set<string>(),delayedTargets=new Set<string>();
   const literal=body.replace(/\{%[\s\S]*?%\}|\{#[\s\S]*?#\}|\{[\s\S]*?\}/g,fragment=>fragment.replace(/[^\n]/g,' '));
   for(const line of literal.split('\n')){
    const token=line.trim().split(/\s+/,1)[0];
    const command=/^[\p{L}_][\p{L}\p{N}_.]*$/u.test(token)?token.toUpperCase():undefined;
    if(command)commands.add(command);
    if(command==='UPDATE_DELAYED_GCODE'){const id=line.match(/\bID\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\b/i)?.[1];if(id)delayedTargets.add(id);}
   }
   return {section,gcodeSha256:sha(body),definitions:definitions.get(section)??[],literalCommands:[...commands].sort(),literalDelayedTargets:[...delayedTargets].sort(),hasTemplate:body.includes('{'),...options.rename_existing?{renameExisting:options.rename_existing}:{}};
  }).sort((a,b)=>a.section.localeCompare(b.section,'en'));
  packages.push({archive:basename(archive),archiveSha256:sha(bytes),primary:primary[0],seriesIdentity:'unconfirmed',effectiveSectionCount:Object.keys(inspection.source.original).filter(name=>name!=='DEFAULT').length,activeFiles:inspection.versions.map(file=>({file:relative(directory,file.filename),sha256:file.sha256})),excludedMembers:members.filter(name=>!inspection.versions.some(file=>relative(directory,file.filename)===name)),macros});
 }
 const sourceRevision=execFileSync('git',['-C',resolve(import.meta.dirname,'../..'),'rev-parse','HEAD'],{encoding:'utf8',timeout:10000}).trim();
 const sourceHashes=await Promise.all(['scripts/inspect-legacy-macros.ts','src/config/klipper-files.ts','src/config/klipper-text.ts','src/config/klipper-autosave.ts'].map(async file=>({file,sha256:sha(await readFile(resolve(import.meta.dirname,'..',file)))})));
 await writeFile(output,JSON.stringify({version:1,sourceRevision,sourceHashes,node:process.version,method:'inspectKlipperConfiguration; active includes and SAVE_CONFIG; literal command inventory only',limitations:['No template rendering, branch expansion, plugin loading, device access or motion','Archive labels do not establish Cycnumbris 500 series identity','Definition locations show occurrences, not option-level winning provenance','No configuration values, credentials or machine identifiers are exported'],packages},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(packages.map(p=>({archive:p.archive,sha256:p.archiveSha256,sections:p.effectiveSectionCount,activeFiles:p.activeFiles.length,macros:p.macros.length,duplicates:p.macros.filter(m=>m.definitions.length>1).map(m=>m.section)})),null,2));
}finally{await rm(root,{recursive:true,force:true});}
