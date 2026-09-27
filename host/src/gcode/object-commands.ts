// GPL-3.0-or-later. Object commands from klippy/extras/exclude_object.py.
// Original Copyright (C) 2019 Eric Callahan; (C) 2021 Troy Jacobson.
import {GCodeError,type GCodeDispatch} from './dispatch.ts';
import {GCodeMove,type MovePort} from './move.ts';
import {ObjectExclusionTransform} from './object-exclusion.ts';
type Definition={name:string;[key:string]:string|number[]|number[][]};
function canonical(value:string):string{const result=value.toUpperCase();if(!result||result.length>256||/[\x00-\x1f\x7f]/u.test(result))throw new GCodeError('Invalid object name');return result;}
function compare(a:string,b:string):number{const x=Array.from(a,c=>c.codePointAt(0)!),y=Array.from(b,c=>c.codePointAt(0)!);for(let i=0;i<Math.min(x.length,y.length);i++)if(x[i]!==y[i])return x[i]-y[i];return x.length-y.length;}
function point(value:unknown):value is number[]{return Array.isArray(value)&&value.length===2&&value.every(v=>typeof v==='number'&&Number.isFinite(v));}
/** Owns the transform head. File lifecycle must reset before preparation and
 * detach after final motion drains. Definitions remain visible after finish. */
export class ObjectCommands {
 readonly #coordinates:GCodeMove;readonly #downstream:MovePort;
 #revision=0n;
 get revision(){return this.#revision.toString();}
 #transform:ObjectExclusionTransform|undefined;#objects:Definition[]=[];#completedExcluded:string[]=[];#current:string|null=null;
 constructor(coordinates:GCodeMove,downstream:MovePort){if(!coordinates.usesPort(downstream))throw new Error('Object coordinate ownership mismatch');this.#coordinates=coordinates;this.#downstream=downstream;}
 get status(){return {objects:structuredClone(this.#objects),excluded_objects:this.#transform?.status.excluded_objects??[...this.#completedExcluded],current_object:this.#current};}
 exclude(value:string):void{
  const name=canonical(value);let transform=this.#transform;
  if(!transform){if(!this.#coordinates.usesPort(this.#downstream))throw new Error('Object transform ownership changed');transform=new ObjectExclusionTransform(this.#downstream);if(this.#current)transform.start(this.#current);transform.exclude(name);this.#coordinates.setPort(transform);this.#transform=transform;}
  else transform.exclude(name);
  this.#revision++;
 }
 finish():void{if(this.#transform){if(!this.#coordinates.usesPort(this.#transform))throw new Error('Object transform ownership changed');this.#completedExcluded=this.#transform.status.excluded_objects;this.#coordinates.setPort(this.#downstream);this.#coordinates.resetPosition();this.#transform=undefined;}this.#current=null;}
 reset():void{this.#revision++;this.finish();this.#objects=[];this.#completedExcluded=[];}
 #add(definition:Definition):void{if(this.#objects.length>=1024)throw new GCodeError('Object definition capacity exceeded');this.#revision++;this.#objects=[...this.#objects,definition].sort((a,b)=>compare(a.name,b.name));}
 register(dispatch:GCodeDispatch):void{
  dispatch.register('EXCLUDE_OBJECT_START',c=>{if(c.params.NAME===undefined)throw new GCodeError('Missing object NAME');const name=canonical(c.params.NAME);if(!this.#objects.some(o=>o.name===name))this.#add({name});this.#current=name;this.#transform?.start(name);});
  dispatch.register('EXCLUDE_OBJECT_END',c=>{if(this.#current===null&&this.#transform){c.respondInfo('EXCLUDE_OBJECT_END called, but no object is currently active');return;}if(c.params.NAME!==undefined&&canonical(c.params.NAME)!==this.#current)c.respondInfo('EXCLUDE_OBJECT_END NAME does not match the current object');this.#current=null;this.#transform?.end();});
  dispatch.register('EXCLUDE_OBJECT',c=>{
   const name=c.params.NAME?canonical(c.params.NAME):undefined;
   // Original flags use nonempty string truthiness, including RESET=0.
   if(c.params.RESET){this.#transform?.unexclude(name);this.#revision++;}
   else if(name)this.exclude(name);
   else if(c.params.CURRENT){if(!this.#current)throw new GCodeError('There is no current object to cancel');this.exclude(this.#current);}
   else c.respondInfo('Excluded objects: '+this.status.excluded_objects.join(' '));
  });
  dispatch.register('EXCLUDE_OBJECT_DEFINE',c=>{
   if(c.params.RESET){this.reset();return;}
   if(!c.params.NAME){c.respondInfo('Known objects: '+(c.params.JSON!==undefined?JSON.stringify(this.#objects):this.#objects.map(o=>o.name).join(' ')));return;}
   const definition:Definition={name:canonical(c.params.NAME)};
   for(const [key,value] of Object.entries(c.params)){
    if(key==='NAME')continue;
    if(key==='CENTER'||key==='POLYGON'){
     let parsed:unknown;try{parsed=JSON.parse(key==='CENTER'?'['+value+']':value);}catch{throw new GCodeError('Invalid object '+key);}
     if(key==='CENTER'){if(!point(parsed))throw new GCodeError('Invalid object CENTER');definition.center=parsed;}
     else{if(!Array.isArray(parsed)||parsed.length>4096||!parsed.every(point))throw new GCodeError('Invalid object POLYGON');definition.polygon=parsed;}
    }else{if(key.length>256||value.length>4096||Object.keys(definition).length>=64)throw new GCodeError('Object metadata limit');Object.defineProperty(definition,key,{value,enumerable:true,writable:true,configurable:true});}
   }
   this.#add(definition);
  });
 }
}
