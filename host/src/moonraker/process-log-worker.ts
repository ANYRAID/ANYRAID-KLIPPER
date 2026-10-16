// Native process logging, ported from pinned Moonraker loghelper.py.
// Original Copyright (C) 2023 Eric Callahan. GPL-3.0-or-later.
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {parentPort,workerData} from 'node:worker_threads';
import {constants,openSync,closeSync,writeSync,fstatSync,renameSync,unlinkSync,readdirSync,realpathSync,lstatSync,linkSync} from 'node:fs';
import {basename,dirname} from 'node:path';
import {platform,release} from 'node:os';
interface Options {paths:Record<string,string>;structured:boolean;version:string;now?:number;}
const native=createRequire(import.meta.url)(process.env.ANYRAID_SEALED_FILE_ADDON??'../../build/sealed-file.node') as {lockDirectory(fd:number):void};
const locks=new Map<string,number>();
const options=workerData as Options,files=new Map<string,{fd:number;path:string;midnight:number;day:string}>();
const time=()=>options.now??Date.now(),pad=(n:number)=>String(n).padStart(2,'0');
const day=(ms:number)=>{const d=new Date(ms);return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;};
const midnight=(ms:number)=>{const d=new Date(ms);d.setHours(24,0,0,0);return d.valueOf();};
const timestamp=(ms:number)=>{const d=new Date(ms);return `${day(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())},${String(d.getMilliseconds()).padStart(3,'0')}`;};
function write(fd:number,text:string){const bytes=Buffer.from(text);for(let at=0;at<bytes.length;){const count=writeSync(fd,bytes,at,bytes.length-at);if(!count)throw new Error('Short log write');at+=count;}}
function record(message:string,level:string,ms:number,func='lifecycle'){return options.structured?JSON.stringify({time:timestamp(ms),level,file:'product-host.ts',function:func,line:0,message:message.trim()})+'\n':`${timestamp(ms)} [product-host.ts:${func}()] - ${message}\n`;}
function header(name:string,ms:number){const message=`platform: ${platform()} ${release()}\nnode_version: ${process.versions.node}\nsoftware_version: ${options.version}\napplication: ${name}\nstructured_logging: ${options.structured}`;return options.structured?record(message,'INFO',ms,'write_header'):`-------------------- Log Start | ${new Date(ms).toUTCString()} --------------------\n${message}\n`;}
/** Recover only this producer's private rotation namespace under the directory
 * flock. A crash after link but before publish has one dated alias to current;
 * arbitrary/external hardlinks still reject. Staging names are reserved UUIDs. */
function recover(path:string){const prefix=basename(path)+'.',directory=dirname(path),names=readdirSync(directory);if(names.length>4096)throw new Error('Log directory entry limit');let current:ReturnType<typeof lstatSync>|undefined;try{current=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(current&&current.nlink!==1){if(!current.isFile()||current.nlink!==2||current.uid!==process.getuid!())throw new Error('Invalid log links');const aliases=names.filter(name=>name.startsWith(prefix)&&/^\d{4}-\d{2}-\d{2}$/.test(name.slice(prefix.length))).filter(name=>{const info=lstatSync(directory+'/'+name);return info.isFile()&&info.dev===current!.dev&&info.ino===current!.ino;});if(aliases.length!==1)throw new Error('Invalid log links');unlinkSync(directory+'/'+aliases[0]);}
 for(const name of names)if(name.startsWith(prefix+'rotate-')&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name.slice((prefix+'rotate-').length))){const info=lstatSync(directory+'/'+name);if(!info.isFile()||info.uid!==process.getuid!()||info.nlink!==1||(info.mode&0o777)!==0o600)throw new Error('Invalid log staging ownership');unlinkSync(directory+'/'+name);}
}
function open(path:string,exclusive=false){const fd=openSync(path,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK|(exclusive?constants.O_EXCL:0),0o600);try{if(!fstatSync(fd).isFile()||fstatSync(fd).nlink!==1)throw new Error('Invalid log file');return fd;}catch(error){closeSync(fd);throw error;}}
function rotate(name:string,ms:number){const file=files.get(name);if(!file)throw new Error('File Logging Disabled');const backup=file.path+'.'+file.day;
 // The download owner retains its independently opened old inode. Reopen an
 // exclusive new inode; never truncate an uploaded/symlink replacement.
 const held=fstatSync(file.fd),current=lstatSync(file.path);if(held.dev!==current.dev||held.ino!==current.ino||current.nlink!==1)throw new Error('Log file ownership changed');
 const temporary=file.path+'.rotate-'+randomUUID();let fresh=-1,published=false;
 try{fresh=open(temporary,true);write(fresh,header(name,ms));try{unlinkSync(backup);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}linkSync(file.path,backup);const linked=lstatSync(backup),before=lstatSync(file.path);if(linked.dev!==held.dev||linked.ino!==held.ino||before.dev!==held.dev||before.ino!==held.ino)throw new Error('Log file ownership changed');
 // Prepare the header before atomically replacing the public filename. Existing
 // readers retain the prior inode; new opens never observe a missing filename.
 renameSync(temporary,file.path);published=true;closeSync(file.fd);file.fd=fresh;fresh=-1;file.day=day(ms);file.midnight=midnight(ms);
 const prefix=basename(file.path)+'.',names=readdirSync(dirname(file.path)).filter(n=>n.startsWith(prefix)&&/^\d{4}-\d{2}-\d{2}$/.test(n.slice(prefix.length))).sort();for(const old of names.slice(0,-2))unlinkSync(dirname(file.path)+'/'+old);
 }finally{if(fresh>=0)closeSync(fresh);if(!published)try{unlinkSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}

}
function cleanup(){for(const file of files.values())if(file.fd>=0){closeSync(file.fd);file.fd=-1;}for(const fd of locks.values())closeSync(fd);locks.clear();}
try{for(const [name,path] of Object.entries(options.paths)){const parent=realpathSync(dirname(path)),physical=parent+'/'+basename(path),existing=locks.get(parent);if(existing===undefined){const lockFd=openSync(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);locks.set(parent,lockFd);const info=fstatSync(lockFd);if(info.uid!==process.getuid!()||(info.mode&0o077)!==0)throw new Error('Logs require a private directory owned by service');native.lockDirectory(lockFd);}const anchored='/proc/self/fd/'+locks.get(parent)!+'/'+basename(physical);recover(anchored);const fd=open(anchored),ms=time(),modified=fstatSync(fd).mtimeMs;files.set(name,{fd,path:'/proc/self/fd/'+locks.get(parent)!+'/'+basename(physical),midnight:midnight(modified),day:day(modified)});write(fd,header(name,ms));}parentPort!.postMessage({id:0});}
catch(error){cleanup();parentPort!.postMessage({id:0,error:(error as NodeJS.ErrnoException).code??'LOG_OPEN_FAILED'});}
parentPort!.on('message',(task:{id:number;kind:string;name?:string;message?:string;level?:string;now?:number})=>{
 try{if(task.kind==='close'){cleanup();parentPort!.postMessage({id:task.id});parentPort!.close();return;}
 if(task.kind==='time'){options.now=task.now;}
 else if(task.kind==='rollover')rotate(task.name!,time());
 else if(task.kind==='record'){const file=files.get(task.name!);if(file){const ms=time();if(ms>=file.midnight)rotate(task.name!,ms);if(file.fd<0)throw new Error('Log file closed');write(file.fd,record(task.message!,task.level!,ms));}}
 parentPort!.postMessage({id:task.id});
 }catch(error){parentPort!.postMessage({id:task.id,error:(error as NodeJS.ErrnoException).code??'LOG_WRITE_FAILED'});}
});
