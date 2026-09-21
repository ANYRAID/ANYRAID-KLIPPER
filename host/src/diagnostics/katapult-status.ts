import {katapultFrame,katapultReply,katapultInfo,type KatapultTransport} from './katapult.ts';
export async function katapultStatus(transport:KatapultTransport,signal:AbortSignal,uuid?:string){
 if(uuid!==undefined&&!/^[a-f\d]{12}$/i.test(uuid))throw new TypeError('Invalid Katapult UUID');
 const request=async(command:number)=>{signal.throwIfAborted();const reply=await transport.exchange(katapultFrame(command),2000,signal);signal.throwIfAborted();return katapultReply(command,reply);};
 const info=katapultInfo(await request(0x11));if(uuid!==undefined){const id=await request(0x16);if(id.length<6||id.subarray(0,6).toString('hex')!==uuid.toLowerCase())throw new Error('Katapult UUID mismatch');}return info;
}
