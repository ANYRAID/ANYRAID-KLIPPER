import {crc32,deflateRawSync} from 'node:zlib';
export interface UfpMember {name:string;data:Buffer;method?:0|8;crc?:number;}
/** Independent ZIP fixture writer: never calls the production archive reader. */
export function ufpFixture(members:UfpMember[]):Buffer{
 const locals:Buffer[]=[],directory:Buffer[]=[];let offset=0;
 for(const member of members){
  const name=Buffer.from(member.name),method=member.method??8,data=method===8?deflateRawSync(member.data):member.data,checksum=member.crc??crc32(member.data);
  const local=Buffer.alloc(30),central=Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(method,8);local.writeUInt32LE(checksum,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(member.data.length,22);local.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(method,10);central.writeUInt32LE(checksum,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(member.data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
  locals.push(local,name,data);directory.push(central,name);offset+=local.length+name.length+data.length;
 }
 const entries=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(members.length,8);end.writeUInt16LE(members.length,10);end.writeUInt32LE(entries.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,entries,end]);
}
