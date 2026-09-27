import type {FatBlockDevice} from '../../src/diagnostics/fatfs.ts';
export function fatDisk(){
 const image=Buffer.alloc(8192*512);image.set([0xeb,0x3c,0x90]);image.write('MSDOS5.0',3);image.writeUInt16LE(512,11);image[13]=1;image.writeUInt16LE(1,14);image[16]=2;image.writeUInt16LE(512,17);image.writeUInt16LE(8192,19);image[21]=248;image.writeUInt16LE(32,22);image.writeUInt16LE(0xaa55,510);for(const sector of [1,33]){image.writeUInt16LE(0xfff8,sector*512);image.writeUInt16LE(0xffff,sector*512+2);}let writes=0;
 const device:FatBlockDevice={sectors:8192,writeProtected:false,async readSector(sector,s){s.throwIfAborted();return image.subarray(sector*512,(sector+1)*512);},async writeSector(sector,data,s){s.throwIfAborted();writes++;image.set(data,sector*512);},async sync(s){s.throwIfAborted();}};return {device,image,get writes(){return writes;}};
}
