// Dynamic MCU dictionary support derived from klippy/msgproto.py (GPL-3.0-or-later).
// Original Copyright (C) 2016-2024 Kevin O'Connor.
import { inflateSync } from 'node:zlib';
import { checkFrame,decodeInteger,encodeInteger,ProtocolError } from './codec.ts';
export type WireValue=number|string|Uint8Array;
type Format='%u'|'%i'|'%hu'|'%hi'|'%c'|'%s'|'%.*s'|'%*s';
interface Parameter {name:string;format:Format;enumeration?:Map<string,number>;reverse?:Map<number,string>;}
interface Message {id:number;name:string;format:string;kind:'command'|'response'|'output';parameters:Parameter[];}
export interface DecodedMessage {name:string;parameters:Record<string,WireValue>;}
const formats=new Set(['%u','%i','%hu','%hi','%c','%s','%.*s','%*s']);
const dynamic=(format:Format)=>format==='%s'||format==='%.*s'||format==='%*s';
function object(value:unknown):Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new ProtocolError('Expected dictionary object');
  return value as Record<string,unknown>;
}
function wireInteger(value:unknown):number {
  if(typeof value!=='number') throw new ProtocolError('Expected MCU integer');
  encodeInteger(value);return value;
}
export class MessageDictionary {
  #byId=new Map<number,Message>();
  #byName=new Map<string,Message>();
  #enumerations=new Map<string,Map<string,number>>();
  #config:Record<string,unknown>=Object.create(null);
  #raw=new Uint8Array();
  version='';
  buildVersions='';
  kconfig:unknown=null;
  constructor() {
    this.#register('identify_response offset=%u data=%.*s',0,'response');
    this.#register('identify offset=%u count=%c',1,'command');
  }
  /** Atomic replacement after decompression and complete schema validation. */
  identify(bytes:Uint8Array,compressed=true):void {
    if(bytes.length>4*1024*1024) throw new ProtocolError('Identify data too large');
    const raw=compressed ? inflateSync(bytes,{maxOutputLength:4*1024*1024}) : bytes;
    const data=object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)));
    const next=new MessageDictionary();
    let expanded=0;
    for(const [name,items] of Object.entries(object(data.enumerations??{}))) {
      const values=new Map<string,number>();
      for(const [key,value] of Object.entries(object(items))) {
        if(typeof value==='number') {
          values.set(key,wireInteger(value)); expanded++;
        } else {
          if(!Array.isArray(value) || value.length!==2) throw new ProtocolError('Invalid enumeration range');
          const start=wireInteger(value[0]),count=value[1];
          if(!Number.isInteger(count) || count<0 || count>65536) throw new ProtocolError('Invalid enumeration count');
          expanded+=count;
          if(expanded>100000) throw new ProtocolError('Too many enumeration values');
          const match=/^(.*?)(\d+)$/.exec(key),root=match?.[1]??key,base=match ? Number(match[2]) : 0;
          if(!Number.isSafeInteger(base+count)) throw new ProtocolError('Invalid enumeration suffix');
          for(let i=0;i<count;i++) values.set(root+(base+i),wireInteger(start+i));
        }
        if(expanded>100000) throw new ProtocolError('Too many enumeration values');
      }
      next.#enumerations.set(name,values);
    }
    for(const [kind,entries] of [['command',data.commands],['response',data.responses],['output',data.output??{}]] as const)
      for(const [format,id] of Object.entries(object(entries))) next.#register(format,wireInteger(id),kind);
    next.#config=structuredClone(object(data.config??{}));
    if((data.version!==undefined && typeof data.version!=='string') || (data.build_versions!==undefined && typeof data.build_versions!=='string'))
      throw new ProtocolError('Invalid firmware version');
    this.#byId=next.#byId;this.#byName=next.#byName;this.#enumerations=next.#enumerations;this.#config=next.#config;
    this.version=(data.version as string)??'';this.buildVersions=(data.build_versions as string)??'';this.kconfig=structuredClone(data.kconfig??null);
    this.#raw=Uint8Array.from(raw);
  }
  get rawIdentify():Uint8Array {return this.#raw.slice();}
  hasConstant(name:string):boolean{return Object.hasOwn(this.#config,name);}
  constant(name:string):unknown {
    if(!Object.hasOwn(this.#config,name)) throw new ProtocolError(`Missing firmware constant: ${name}`);
    return structuredClone(this.#config[name]);
  }
  lookup(format:string):Readonly<{id:number;name:string}> {
    const name=format.trim().split(/\s+/)[0],message=this.#byName.get(name);
    if(!message || message.format!==format) throw new ProtocolError(`Unknown or mismatched command: ${name}`);
    return {id:message.id,name};
  }
  encode(name:string,params:Readonly<Record<string,WireValue>>):Uint8Array {
    const message=this.#byName.get(name);
    if(!message) throw new ProtocolError(`Unknown message: ${name}`);
    if(Object.keys(params).length!==message.parameters.length) throw new ProtocolError('Parameter count mismatch');
    const out=encodeInteger(message.id);
    for(const param of message.parameters) {
      if(!Object.hasOwn(params,param.name)) throw new ProtocolError(`Missing parameter: ${param.name}`);
      const value=params[param.name];
      if(param.enumeration) {
        const number=typeof value==='string' ? param.enumeration.get(value) : undefined;
        if(number===undefined) throw new ProtocolError(`Unknown enumeration value for ${param.name}`);
        encodeInteger(number,out);
      } else if(dynamic(param.format)) {
        if(!(value instanceof Uint8Array) || value.length>255) throw new ProtocolError('Expected bounded byte buffer');
        out.push(value.length,...value);
      } else encodeInteger(wireInteger(value),out);
    }
    if(out.length>59) throw new ProtocolError('Message exceeds frame payload');
    return Uint8Array.from(out);
  }
  parseFrame(frame:Uint8Array):DecodedMessage[] {
    const length=checkFrame(frame);
    if(length<=0 || length!==frame.length) throw new ProtocolError('Invalid or concatenated frame');
    const end=frame.length-3,result:DecodedMessage[]=[];
    let pos=2;
    while(pos<end) {
      const tag=decodeInteger(frame,pos,true,end);pos=tag.next;
      const message=this.#byId.get(tag.value);
      if(!message) {result.push({name:'#unknown',parameters:{'#msgid':tag.value,'#msg':frame.slice()}});break;}
      const params:Record<string,WireValue>=Object.create(null);
      for(const parameter of message.parameters) {
        let value:WireValue;
        if(dynamic(parameter.format)) {
          if(pos>=end) throw new ProtocolError('Missing string length');
          const length=frame[pos++];
          if(pos+length>end) throw new ProtocolError('Truncated string');
          value=frame.slice(pos,pos+length);pos+=length;
        } else {
          const parsed=decodeInteger(frame,pos,parameter.format==='%i'||parameter.format==='%hi',end);
          value=parameter.reverse?.get(parsed.value)??(parameter.reverse ? `?${parsed.value}` : parsed.value);
          pos=parsed.next;
        }
        params[parameter.name]=value;
      }
      // Output messages preserve typed arguments; UI formatting is a separate boundary.
      if(message.kind==='output') params['#format']=message.format;
      result.push({name:message.name,parameters:params});
    }
    return result;
  }
  #register(format:string,id:number,kind:Message['kind']):void {
    const encoded=encodeInteger(id);
    if(encoded.length>2) throw new ProtocolError('MCU message IDs must fit two bytes');
    const old=this.#byId.get(id);
    if(old && old.format!==format) throw new ProtocolError('Conflicting message IDs');
    let name:string,parameters:Parameter[]=[];
    if(kind==='output') {
      name='#output';
      for(let i=0;i<format.length;i++) {
        if(format[i]!=='%') continue;
        if(format[i+1]==='%') {i++;continue;}
        const token=/^%(?:\.\*s|\*s|hu|hi|u|i|c|s)/.exec(format.slice(i))?.[0];
        if(!token) throw new ProtocolError('Invalid output format');
        parameters.push({name:String(parameters.length),format:token as Format});i+=token.length-1;
      }
    } else {
      const parts=format.trim().split(/\s+/);name=parts.shift()!;
      if(!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name)) throw new ProtocolError('Invalid message name');
      const oldName=this.#byName.get(name);
      if(oldName && (oldName.id!==id || oldName.format!==format)) throw new ProtocolError('Conflicting message name');
      const names=new Set<string>();
      parameters=parts.map(part=>{
        const fields=part.split('='),[key,type]=fields;
        if(fields.length!==2 || !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(key) || !formats.has(type) || names.has(key))
          throw new ProtocolError('Invalid parameter format');
        names.add(key);
        const enumeration=[...this.#enumerations].find(([enumName])=>key===enumName || key.endsWith('_'+enumName))?.[1];
        if(enumeration && dynamic(type as Format)) throw new ProtocolError('String enumeration is unsupported');
        return {name:key,format:type as Format,enumeration,reverse:enumeration ? new Map([...enumeration].map(([k,v])=>[v,k])) : undefined};
      });
    }
    const message={id,name,format,kind,parameters};this.#byId.set(id,message);
    if(kind!=='output') this.#byName.set(name,message);
  }
}
