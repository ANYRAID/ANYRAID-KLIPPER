import {createHash} from 'node:crypto';
import {parseCommand,extendedParameters} from './parser.ts';
import type {GCodeFileReader} from './file-reader.ts';
/** Consume a fresh authorized reader without dispatching any G-code. Caller
 * owns its storage lease and closure. EOF validates ordinary source mutations.
 * Digest covers normalized UTF-8 G-code lines (CRLF becomes LF), not raw bytes. */
export async function readFileObjectFootprint(reader:GCodeFileReader,signal:AbortSignal){
 if(reader.status.position!==0||reader.status.pending||reader.status.closed||reader.status.eof)throw new Error('Footprint requires a fresh authorized reader');
 const identity=reader.identity,hash=createHash('sha256'),polygons:number[][][]=[],defined=new Set<string>(),started=new Set<string>();let vertices=0,incomplete=false;
 for(;;){
  const batch=await reader.next(signal);if(!batch)break;hash.update(batch.script+'\n');
  for(const line of batch.script.split('\n')){
   if(!/EXCLUDE_OBJECT_(?:DEFINE|START)/i.test(line))continue;
   const command=parseCommand(line);if(command.command!=='EXCLUDE_OBJECT_DEFINE'&&command.command!=='EXCLUDE_OBJECT_START')continue;
   const p=extendedParameters(command);if(command.command==='EXCLUDE_OBJECT_DEFINE'&&(p.RESET||!p.NAME))continue;
   if(!p.NAME||p.NAME.length>256||/[\x00-\x1f\x7f]/.test(p.NAME))throw new RangeError('Invalid footprint object name');
   const name=p.NAME.toUpperCase();if(command.command==='EXCLUDE_OBJECT_START'){started.add(name);if(started.size>1024)throw new RangeError('Footprint object limit exceeded');continue;}
   defined.add(name);if(defined.size>1024)throw new RangeError('Footprint object limit exceeded');
   if(p.POLYGON===undefined){incomplete=true;continue;}
   let polygon:unknown;try{polygon=JSON.parse(p.POLYGON);}catch{throw new RangeError('Invalid footprint polygon JSON');}
   if(!Array.isArray(polygon)||polygon.length<3||polygon.length>4096||!polygon.every(v=>Array.isArray(v)&&v.length===2&&v.every(n=>typeof n==='number'&&Number.isFinite(n))))throw new RangeError('Invalid footprint polygon');
   vertices+=polygon.length;if(vertices>65536||polygons.length>=1024)throw new RangeError('Footprint polygon limit exceeded');
   // Keep every definition, including earlier definitions before RESET or rename:
   // a later definition must not erase an earlier printed object's coverage.
   polygons.push(polygon);
  }
  reader.commit(batch);
 }
 signal.throwIfAborted();if([...started].some(name=>!defined.has(name)))incomplete=true;
 return {identity,digest:hash.digest('hex'),digestFormat:'sha256-normalized-gcode-v1' as const,complete:!incomplete&&polygons.length>0,polygons:incomplete?[]:polygons};
}
