import {sdCRC7,sdCRC16,type SDCardSPITransport} from '../../src/diagnostics/sd-card-spi.ts';
export class SDCardEmulator implements SDCardSPITransport {
 commands:{command:number;argument:number}[]=[];writes:Uint8Array[]=[];response:number[]=[];frame:number[]|undefined;badCRC=false;shortResponse=false;busy=false;rejectStatus=false;
 readonly data=Uint8Array.from({length:512},(_,i)=>i&255);readonly cid=new Uint8Array(16);readonly csd=new Uint8Array(16);
 readonly high:boolean;constructor(high=true,protectedCard=false){this.high=high;
  this.cid.set([3,79,69,67,65,82,68,49,0x12,1,2,3,4,1,0x91]);this.cid[15]=sdCRC7(this.cid.subarray(0,15));
  this.csd[0]=high?64:0;if(high)this.csd[9]=3;else{this.csd[5]=9;this.csd[7]=255;this.csd[8]=0xc0;}
  this.csd[14]=protectedCard?0x30:0;this.csd[15]=sdCRC7(this.csd.subarray(0,15));
 }
 #block(data:Uint8Array){const crc=sdCRC16(data)^(this.badCRC?1:0);this.response=[0,254,...data,crc>>>8,crc&255,255];}
 async send(data:Uint8Array,signal:AbortSignal){
  signal.throwIfAborted();
  if(this.frame){this.frame.push(...data);if(this.frame.length===515){this.writes.push(Uint8Array.from(this.frame));this.frame=undefined;this.response=[5,...Array(this.busy?128:1).fill(this.busy?0:255)];}return;}
  if(data.length!==6)throw new Error('Unexpected command length');if(sdCRC7(data.subarray(0,5))!==data[5])throw new Error('Command CRC');
  const command=data[0]&63,argument=Buffer.from(data).readUInt32BE(1);this.commands.push({command,argument});
  const replies:Record<number,number[]>={0:[1],8:this.high?[1,0,0,1,10]:[5],59:[1],55:[1],41:[0],58:this.high?[0,64,255,128,0]:[1,0,255,128,0],16:[0],24:[0],13:[0,this.rejectStatus?1:0]};
  if(command===10)this.#block(this.cid);else if(command===9)this.#block(this.csd);else if(command===17)this.#block(this.data);else{this.response=[...(replies[command]??[4])];while(this.response.length<8)this.response.push(255);if(command===24)this.frame=[];}
 }
 async transfer(data:Uint8Array,signal:AbortSignal){signal.throwIfAborted();if(this.shortResponse)return new Uint8Array();return Uint8Array.from(data,()=>this.response.shift()??255);}
}
