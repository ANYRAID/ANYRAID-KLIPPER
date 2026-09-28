// GPL-3.0-or-later. Replaces klippy/parsedump.py (Kevin O'Connor, 2016).
import {checkFrame,MAX_FRAME} from '../protocol/codec.ts';
import {MessageDictionary,type DecodedMessage,type WireValue} from '../protocol/dictionary.ts';
function bytes(value:Uint8Array):string{
 let result="b'";for(const byte of value)result+=byte===39?"\\'":byte===92?'\\\\':byte===10?'\\n':byte===13?'\\r':byte===9?'\\t':byte>=32&&byte<127?String.fromCharCode(byte):'\\x'+byte.toString(16).padStart(2,'0');return result+"'";
}
const value=(v:WireValue)=>v instanceof Uint8Array?bytes(v):String(v);
export function formatDumpMessage(message:DecodedMessage):string{
 const p=message.parameters;
 if(message.name==='#unknown')return '#unknown '+value(p['#msg']);
 if(message.name==='#output'){
  let index=0;return '#output '+String(p['#format']).replace(/%%|%(?:\.\*s|\*s|hu|hi|u|i|c|s)/g,token=>token==='%%'?'%':value(p[String(index++)]));
 }
 return message.name+Object.entries(p).map(([name,v])=>' '+name+'='+value(v)).join('');
}
/** Offline byte-wise recovery matches the legacy dump reader, not live wire
 * sync recovery. Retains at most one MCU frame, independent of input size. */
export class SerialDumpDecoder {
 readonly dictionary:MessageDictionary;#buffer=new Uint8Array(MAX_FRAME);#length=0;
 frames=0;messages=0;discardedBytes=0;
 constructor(dictionary:MessageDictionary){this.dictionary=dictionary;}
 get pendingBytes(){return this.#length;}
 *push(chunk:Uint8Array):Generator<string>{
  for(const byte of chunk){this.#buffer[this.#length++]=byte;
   for(;;){const frame=this.#buffer.subarray(0,this.#length),length=checkFrame(frame);if(!length)break;
    if(length<0){this.discardedBytes++;this.#buffer.copyWithin(0,1,this.#length--);continue;}
    const lines=this.dictionary.parseFrame(frame.subarray(0,length)).map(formatDumpMessage);this.frames++;this.messages+=lines.length;
    this.#buffer.copyWithin(0,length,this.#length);this.#length-=length;
    if(lines.length)yield lines.join('\n')+'\n';
   }
  }
 }
 finish(){if(this.#length)throw new Error('Truncated serial dump: '+this.#length+' trailing bytes');}
}
export async function* decodeSerialDump(dictionary:MessageDictionary,input:AsyncIterable<Uint8Array>,report:(decoder:SerialDumpDecoder)=>void=()=>{}):AsyncGenerator<string>{
 const decoder=new SerialDumpDecoder(dictionary);try{for await(const chunk of input){let text='';for(const line of decoder.push(chunk)){text+=line;if(text.length>=65536){yield text;text='';}}if(text)yield text;}decoder.finish();}finally{report(decoder);}
}
