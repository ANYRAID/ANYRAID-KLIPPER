import {endianness} from 'node:os';
/** Internal migration parser. Numeric lexemes are never converted to Number
 * except for explicitly floating-point scalar records. Public JSON/API limits
 * are unchanged. Ordinary persisted records retain their original bytes. */
const decoder=new TextDecoder('utf-8',{fatal:true});
type Member={key:string;raw:string};
function jsonMembers(text:string):Member[]|undefined{
 let at=0,nodes=0;const space=()=>{while(/[\x20\t\r\n]/u.test(text[at]??'!'))at++;};
 const string=()=>{const start=at++;for(;at<text.length;at++){const c=text[at]!;if(c==='"'){at++;const value:unknown=JSON.parse(text.slice(start,at));if(typeof value!=='string'||!value.isWellFormed())throw new Error('Invalid migration JSON string');return value;}if(c==='\\')at++;}throw new Error('Unterminated migration JSON string');};
 const value=(depth:number):Member[]|undefined=>{
  if(depth>64||++nodes>1000000)throw new Error('Migration JSON bounds');space();const c=text[at];
  if(c==='"'){string();return;}
  if(c==='{'||c==='['){const object=c==='{',close=object?'}':']',members:Member[]=[],keys=new Set<string>();at++;space();if(text[at]===close){at++;return object?members:undefined;}
   for(;;){space();let key='';if(object){if(text[at]!== '"')throw new Error('Invalid migration object key');key=string();if(keys.has(key))throw new Error('Duplicate migration object key');keys.add(key);space();if(text[at++]!==':')throw new Error('Invalid migration object');}space();const start=at;value(depth+1);if(object)members.push({key,raw:text.slice(start,at)});space();const separator=text[at++];if(separator===close)break;if(separator!==',')throw new Error('Invalid migration container');}return object?members:undefined;
  }
  const literal=/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(text.slice(at));if(!literal)throw new Error('Invalid migration JSON value');at+=literal[0].length;
  if(!['true','false','null'].includes(literal[0])&&/[.eE]/u.test(literal[0])&&!Number.isFinite(Number(literal[0])))throw new Error('Non-finite migration float');
 };
 const members=value(0);space();if(at!==text.length)throw new Error('Trailing migration JSON data');return members;
}
function scalar(raw:string):Buffer{
 if(raw.startsWith('{')||raw.startsWith('['))return Buffer.from(raw);
 if(raw.startsWith('"'))return Buffer.concat([Buffer.from('s'),Buffer.from(JSON.parse(raw) as string)]);
 if(raw==='null')return Buffer.from([0]);if(raw==='true'||raw==='false')return Buffer.from([63,Number(raw==='true')]);
 const bytes=Buffer.alloc(9),little=endianness()==='LE';
 if(/[.eE]/u.test(raw)){const number=Number(raw);if(!Number.isFinite(number))throw new Error('Non-finite migration float');bytes[0]=100;if(little)bytes.writeDoubleLE(number,1);else bytes.writeDoubleBE(number,1);}
 else{const number=BigInt(raw);if(number<-(1n<<63n)||number>=(1n<<63n))throw new Error('Migration metadata integer exceeds signed 64 bits');bytes[0]=113;if(little)bytes.writeBigInt64LE(number,1);else bytes.writeBigInt64BE(number,1);}
 return bytes;
}
export function validateLegacyRecord(bytes:Uint8Array):void{
 if(!bytes.byteLength||bytes.byteLength>1024*1024)throw new Error('Invalid migration record size');const b=Buffer.from(bytes);
 switch(b[0]){
  case 0:if(b.length===1)return;break;
  case 63:if(b.length===2&&(b[1]===0||b[1]===1))return;break;
  case 113:if(b.length===9)return;break;
  case 100:if(b.length===9&&Number.isFinite(endianness()==='LE'?b.readDoubleLE(1):b.readDoubleBE(1)))return;break;
  case 115:decoder.decode(b.subarray(1));return;
  case 91:case 123:jsonMembers(decoder.decode(b));return;
 }
 throw new Error('Invalid migration record encoding');
}
/** Only the upstream moonraker.database dictionary is split. Containers and
 * normal records preserve their exact source bytes, including unsafe integers. */
export function splitLegacyDatabaseMetadata(bytes:Uint8Array):Array<{key:string;value:Buffer}>|undefined{
 validateLegacyRecord(bytes);if(bytes[0]!==123)return undefined;const members=jsonMembers(decoder.decode(bytes))!;
 return members.map(({key,raw})=>{if(!key||Buffer.byteLength(key)>1024||key.includes('\0'))throw new Error('Invalid migration metadata key');return {key,value:scalar(raw)};});
}
/** Installation metadata only. Inspecting one member does not round or reject
 * unrelated large integers in the enclosing upstream dictionary. */
export function legacyRecordMember(bytes:Uint8Array|undefined,key:string):Buffer|undefined{
 if(bytes===undefined)return;validateLegacyRecord(bytes);if(bytes[0]!==123)throw new Error('Installation metadata requires an object');const member=jsonMembers(decoder.decode(bytes))!.find(m=>m.key===key);return member?scalar(member.raw):undefined;
}
function recordJson(bytes:Uint8Array):string{
 validateLegacyRecord(bytes);const b=Buffer.from(bytes),little=endianness()==='LE';switch(b[0]){
 case 0:return 'null';case 63:return b[1]?'true':'false';case 115:return JSON.stringify(decoder.decode(b.subarray(1)));
 case 113:return (little?b.readBigInt64LE(1):b.readBigInt64BE(1)).toString();
 case 100:{const n=little?b.readDoubleLE(1):b.readDoubleBE(1);return Object.is(n,-0)?'-0.0':n.toExponential();}
 default:return decoder.decode(b);
 }
}
/** Replaces/removes approved metadata members while preserving every other
 * original numeric/container lexeme. Does not broaden public record decoding. */
export function replaceLegacyRecordMembers(bytes:Uint8Array|undefined,changes:ReadonlyMap<string,Uint8Array|null>):Buffer{
 if(bytes!==undefined){validateLegacyRecord(bytes);if(bytes[0]!==123)throw new Error('Installation metadata requires an object');}
 const members=bytes===undefined?[]:jsonMembers(decoder.decode(bytes))!,remaining=new Map(changes),result:Member[]=[];
 for(const member of members){if(!remaining.has(member.key)){result.push(member);continue;}const next=remaining.get(member.key)!;remaining.delete(member.key);if(next!==null)result.push({key:member.key,raw:recordJson(next)});}
 for(const [key,next]of remaining){if(!key||!key.isWellFormed()||key.includes('\0')||Buffer.byteLength(key)>1024)throw new Error('Invalid installation metadata field');if(next!==null)result.push({key,raw:recordJson(next)});}
 const output=Buffer.from('{'+result.map(m=>JSON.stringify(m.key)+':'+m.raw).join(',')+'}');validateLegacyRecord(output);return output;
}
