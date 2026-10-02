// TMC UART framing and acknowledged register access from klippy/extras/tmc_uart.py.
// GPL-3.0-or-later. One bus owner must be shared by all UARTs on an MCU.
const uint=(n:number,max:number)=>{if(!Number.isInteger(n)||n<0||n>max)throw new RangeError('Invalid TMC integer');return n;};
export function tmcCrc(data:Uint8Array):number{
 let crc=0;for(let b of data)for(let bit=0;bit<8;bit++){crc=((crc<<1)^(((crc>>>7)^(b&1))?7:0))&255;b>>>=1;}return crc;
}
function serial(data:Uint8Array):Buffer{
 const out=Buffer.alloc(Math.ceil(data.length*10/8));
 for(let i=0;i<data.length;i++){const word=(data[i]<<1)|512,offset=i*10,byte=offset>>>3,shift=offset&7;out[byte]|=(word<<shift)&255;out[byte+1]|=word>>>(8-shift);}
 return out;
}
export function encodeTmcRead(address:number,register:number):Buffer{
 const data=Buffer.from([0xf5,uint(address,255),uint(register,127),0]);data[3]=tmcCrc(data.subarray(0,3));return serial(data);
}
export function encodeTmcWrite(address:number,register:number,value:number,response=false):Buffer{
 uint(value,0xffffffff);const data=Buffer.alloc(8);data[0]=response?5:0xf5;data[1]=uint(address,255);data[2]=uint(register,127)|(response?0:128);data.writeUInt32BE(value,3);data[7]=tmcCrc(data.subarray(0,7));return serial(data);
}
export function decodeTmcRead(register:number,data:Uint8Array):number|null{
 uint(register,127);if(data.length!==10)return null;
 const byte=(index:number)=>{const offset=index*10+1,pos=offset>>>3,shift=offset&7;return ((data[pos]|(data[pos+1]<<8))>>>shift)&255;};
 const value=byte(3)*0x1000000+byte(4)*0x10000+byte(5)*256+byte(6);
 return encodeTmcWrite(255,register,value,true).equals(data)?value:null;
}
export interface TmcUartTransport {
 /** Must honor abort and settle after the transaction has stopped. Never detach
  * an in-flight query on timeout: another UART may share the MCU scheduler. */
 transfer(oid:number,write:Uint8Array,read:number,minClock:bigint,signal:AbortSignal):Promise<Uint8Array>;
}
/** Serializes complete read/write-IFCNT transactions, including across UART OIDs.
 * No automatic recovery after transport failure. Driver startup owns recovery. */
export class TmcUartBus {
 #transport:TmcUartTransport;#tail:Promise<void>=Promise.resolve();#instances=new Set<string>();#fault:unknown;#failed=false;
 constructor(transport:TmcUartTransport){this.#transport=transport;}
 register(oid:number,address:number):TmcUartDevice{
  uint(oid,255);uint(address,255);const key=oid+':'+address;if(this.#instances.has(key))throw new Error('Duplicate TMC UART address');this.#instances.add(key);return new TmcUartDevice(this,oid,address);
 }
 async transaction<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T>{
  signal.throwIfAborted();const previous=this.#tail,release=Promise.withResolvers<void>();this.#tail=release.promise;
  try{await previous;signal.throwIfAborted();if(this.#failed)throw this.#fault;return await work();}finally{release.resolve();}
 }
 async transfer(oid:number,write:Uint8Array,read:number,minClock:bigint,signal:AbortSignal){
  signal.throwIfAborted();try{const result=await this.#transport.transfer(oid,write,read,minClock,signal);signal.throwIfAborted();return result;}catch(error){this.#failed=true;this.#fault=error;throw error;}
 }
}
export class TmcUartDevice {
 #bus:TmcUartBus;#oid:number;#address:number;#ifcnt:number|undefined;
 constructor(bus:TmcUartBus,oid:number,address:number){this.#bus=bus;this.#oid=oid;this.#address=address;}
 async #read(register:number,signal:AbortSignal):Promise<number>{
  for(let retry=0;retry<5;retry++){const reply=await this.#bus.transfer(this.#oid,encodeTmcRead(this.#address,register),10,0n,signal),value=decodeTmcRead(register,reply);if(value!==null)return value;}
  throw new Error('Unable to read TMC UART register '+register);
 }
 read(register:number,signal:AbortSignal):Promise<number>{uint(register,127);return this.#bus.transaction(signal,()=>this.#read(register,signal));}
 write(register:number,value:number,signal:AbortSignal,minClock=0n):Promise<void>{
  const frame=encodeTmcWrite(this.#address,register,value);if(typeof minClock!=='bigint'||minClock<0n||minClock>0xffffffffffffffffn)throw new RangeError('Invalid TMC clock');
  return this.#bus.transaction(signal,async()=>{
   try{for(let retry=0;retry<5;retry++){
    const before=this.#ifcnt??await this.#read(2,signal);
    await this.#bus.transfer(this.#oid,frame,0,minClock,signal);
    this.#ifcnt=await this.#read(2,signal);if(this.#ifcnt===((before+1)&255))return;
   }throw new Error('Unable to write TMC UART register '+register);}catch(error){this.#ifcnt=undefined;throw error;}
  });
 }
}
