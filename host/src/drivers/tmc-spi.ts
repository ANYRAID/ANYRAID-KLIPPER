// TMC2130-family SPI framing/pipeline from klippy/extras/tmc2130.py.
// GPL-3.0-or-later. SPI words are big endian; chain position one is last.
const integer=(n:number,min:number,max:number)=>{if(!Number.isInteger(n)||n<min||n>max)throw new RangeError('Invalid TMC SPI integer');return n;};
export function encodeTmcSpi(chainLength:number,position:number,register:number,value?:number):Buffer{
 integer(chainLength,1,10);integer(position,1,chainLength);integer(register,0,127);
 const frame=Buffer.alloc(chainLength*5),offset=(chainLength-position)*5;frame[offset]=register|(value===undefined?0:128);
 if(value!==undefined)frame.writeUInt32BE(integer(value,0,0xffffffff),offset+1);return frame;
}
export function decodeTmcSpi(chainLength:number,position:number,response:Uint8Array){
 integer(chainLength,1,10);integer(position,1,chainLength);if(!(response instanceof Uint8Array)||response.length!==chainLength*5)throw new Error('Malformed TMC SPI response');
 const offset=(chainLength-position)*5;return Object.freeze({spiStatus:response[offset],value:response[offset+1]*2**24+response[offset+2]*65536+response[offset+3]*256+response[offset+4]});
}
export interface TmcSpiTransport {
 /** Both transfers must use one MCU FIFO and settle after cancellation. No
  * automatic transport replay: write verification owns the bounded retries. */
 transfer(preface:Uint8Array,data:Uint8Array,minClock:bigint,signal:AbortSignal):Promise<Uint8Array>;
}
export class TmcSpiChain {
 readonly length:number;#transport:TmcSpiTransport;#positions=new Set<number>();#tail:Promise<void>=Promise.resolve();#failed=false;#fault:unknown;
 constructor(transport:TmcSpiTransport,length=1){this.length=integer(length,1,10);this.#transport=transport;}
 register(position=1):TmcSpiDevice{integer(position,1,this.length);if(this.#positions.has(position))throw new Error('Duplicate TMC SPI chain position');this.#positions.add(position);return new TmcSpiDevice(this,position);}
 async transaction<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T>{
  signal.throwIfAborted();const previous=this.#tail,release=Promise.withResolvers<void>();this.#tail=release.promise;
  try{await previous;signal.throwIfAborted();if(this.#failed)throw this.#fault;
   try{return await work();}catch(error){this.#failed=true;this.#fault=error;throw error;}
  }finally{release.resolve();}
 }
 async transfer(preface:Uint8Array,data:Uint8Array,minClock:bigint,signal:AbortSignal){signal.throwIfAborted();const response=await this.#transport.transfer(preface,data,minClock,signal);signal.throwIfAborted();return response;}
}
export class TmcSpiDevice {
 #chain:TmcSpiChain;#position:number;
 constructor(chain:TmcSpiChain,position:number){this.#chain=chain;this.#position=position;}
 readRaw(register:number,signal:AbortSignal){const frame=encodeTmcSpi(this.#chain.length,this.#position,register);return this.#chain.transaction(signal,async()=>decodeTmcSpi(this.#chain.length,this.#position,await this.#chain.transfer(frame,frame,0n,signal)));}
 async read(register:number,signal:AbortSignal):Promise<number>{return (await this.readRaw(register,signal)).value;}
 write(register:number,value:number,signal:AbortSignal,minClock=0n):Promise<void>{
  const frame=encodeTmcSpi(this.#chain.length,this.#position,register,value),dummy=encodeTmcSpi(this.#chain.length,this.#position,0);
  if(typeof minClock!=='bigint'||minClock<0n||minClock>0xffffffffffffffffn)throw new RangeError('Invalid TMC SPI clock');
  return this.#chain.transaction(signal,async()=>{
   for(let retry=0;retry<5;retry++){const result=decodeTmcSpi(this.#chain.length,this.#position,await this.#chain.transfer(frame,dummy,minClock,signal));if(result.value===value)return;}
   throw new Error('Unable to verify TMC SPI register '+register);
  });
 }
}
