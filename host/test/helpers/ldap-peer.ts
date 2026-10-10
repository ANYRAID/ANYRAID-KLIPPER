import {createServer,type Socket} from 'node:net';
import {createServer as createTlsServer,type TLSSocket} from 'node:tls';
export interface LdapPacket {id:number;tag:number;fields:BerField[];socket:Socket|TLSSocket;}
export interface BerField {tag:number;value:Buffer;fields:BerField[];}
function fields(bytes:Buffer):BerField[]{
 const result:BerField[]=[];let offset=0;
 while(offset<bytes.length){const tag=bytes[offset++]!,first=bytes[offset++]!;let length=first;
  if(first&128){const count=first&127;if(count<1||count>4)throw Error('Fixture BER length');length=0;for(let i=0;i<count;i++)length=length*256+bytes[offset++]!;}
  if(offset+length>bytes.length)throw Error('Fixture incomplete BER');const value=bytes.subarray(offset,offset+length);offset+=length;
  result.push({tag,value,fields:tag&32?fields(value):[]});
 }return result;
}
const tlv=(tag:number,value:Buffer)=>{let length:Buffer;if(value.length<128)length=Buffer.from([value.length]);else{const encoded=Buffer.alloc(4);encoded.writeUInt32BE(value.length);const index=encoded.findIndex(byte=>byte!==0);length=Buffer.concat([Buffer.from([128+4-index]),encoded.subarray(index)]);}return Buffer.concat([Buffer.from([tag]),length,value]);};
const string=(value:string)=>tlv(4,Buffer.from(value));
const int=(value:number)=>{const bytes=Buffer.alloc(4);bytes.writeUInt32BE(value);let index=0;while(index<3&&bytes[index]===0&&bytes[index+1]!<128)index++;return tlv(2,bytes.subarray(index));};
const message=(id:number,tag:number,body:Buffer)=>tlv(48,Buffer.concat([int(id),tlv(tag,body)]));
export function ldapResult(packet:LdapPacket,status=0,diagnostic=''){packet.socket.write(message(packet.id,packet.tag===96?97:101,Buffer.concat([tlv(10,Buffer.from([status])),string(''),string(diagnostic)])));}
export function ldapEntry(packet:LdapPacket,dn:string,attributes:Record<string,string[]>={}){
 const attrs=Object.entries(attributes).map(([name,values])=>tlv(48,Buffer.concat([string(name),tlv(49,Buffer.concat(values.map(string)))])));
 packet.socket.write(message(packet.id,100,Buffer.concat([string(dn),tlv(48,Buffer.concat(attrs))])));
}
/** Small independent BER peer for actual ldapts TCP/TLS tests. Not a directory
 * implementation or a substitute for actual customer-directory acceptance. */
export async function ldapPeer(options:{tls?:{key:string;cert:string};handle?:(packet:LdapPacket)=>void}={}){
 const packets:LdapPacket[]=[],sockets=new Set<Socket|TLSSocket>();let connections=0;const errors:string[]=[];
 const connected=(socket:Socket|TLSSocket)=>{connections++;sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));let buffer=Buffer.alloc(0);
  socket.on('data',(chunk:Buffer)=>{buffer=Buffer.concat([buffer,chunk]);try{
   while(buffer.length>=2){let length=buffer[1]!,header=2;if(length&128){const count=length&127;if(count<1||count>4)throw Error('Fixture BER length');if(buffer.length<2+count)break;length=0;for(let i=0;i<count;i++)length=length*256+buffer[header++]!;}if(buffer.length<header+length)break;
    const body=buffer.subarray(header,header+length);buffer=buffer.subarray(header+length);const outer=fields(body),id=outer[0]!.value.reduce((value,byte)=>value*256+byte,0),operation=outer[1]!;
    const packet={id,tag:operation.tag,fields:operation.fields,socket};packets.push(packet);
    if(packet.tag===66){socket.end();continue;}if(options.handle)options.handle(packet);else if(packet.tag===96)ldapResult(packet);else{ldapEntry(packet,'uid=printer,dc=test');ldapResult(packet);}
   }
  }catch(error){errors.push(String(error));socket.destroy();}});
 };
 const server=options.tls?createTlsServer(options.tls,connected):createServer(connected);server.on('tlsClientError',()=>{});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
 const address=server.address();if(!address||typeof address==='string')throw Error('Fixture TCP address');
 return {port:address.port,packets,sockets,errors,get connections(){return connections;},async close(){for(const socket of sockets)socket.destroy();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
