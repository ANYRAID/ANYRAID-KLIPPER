import type {FatBlockDevice} from '../../src/diagnostics/fatfs.ts';
export function fatDisk(){
 const image=Buffer.alloc(8192*512);image.set([0xeb,0x3c,0x90]);image.write('MSDOS5.0',3);image.writeUInt16LE(512,11);image[13]=1;image.writeUInt16LE(1,14);image[16]=2;image.writeUInt16LE(512,17);image.writeUInt16LE(8192,19);image[21]=248;image.writeUInt16LE(32,22);image.writeUInt16LE(0xaa55,510);for(const sector of [1,33]){image.writeUInt16LE(0xfff8,sector*512);image.writeUInt16LE(0xffff,sector*512+2);}let writes=0;
 const device:FatBlockDevice={sectors:8192,writeProtected:false,async readSector(sector,s){s.throwIfAborted();return image.subarray(sector*512,(sector+1)*512);},async writeSector(sector,data,s){s.throwIfAborted();writes++;image.set(data,sector*512);},async sync(s){s.throwIfAborted();}};return {device,image,get writes(){return writes;}};
}
/** FAT32 superfloppy, 64 MiB, mirrored FATs and an allocated root cluster. */
export function fat32Disk(){
 const sectors=131072,image=Buffer.alloc(sectors*512);image.set([0xeb,0x58,0x90]);image.write('MSWIN4.1',3);image.writeUInt16LE(512,11);image[13]=1;image.writeUInt16LE(32,14);image[16]=2;image[21]=248;image.writeUInt32LE(sectors,32);image.writeUInt32LE(1024,36);image.writeUInt32LE(2,44);image.writeUInt16LE(1,48);image.writeUInt16LE(6,50);image[64]=128;image[66]=0x29;image.writeUInt32LE(1234,67);image.write('TEST DISK  ',71);image.write('FAT32   ',82);image.writeUInt16LE(0xaa55,510);image.copy(image,6*512,0,512);
 image.writeUInt32LE(0x41615252,512);image.writeUInt32LE(0x61417272,512+484);image.writeUInt32LE(0xffffffff,512+488);image.writeUInt32LE(0xffffffff,512+492);image.writeUInt32LE(0xaa550000,512+508);image.copy(image,7*512,512,1024);
 for(const sector of [32,1056]){image.writeUInt32LE(0x0ffffff8,sector*512);image.writeUInt32LE(0xffffffff,sector*512+4);image.writeUInt32LE(0x0fffffff,sector*512+8);}let writes=0;
 const device:FatBlockDevice={sectors,writeProtected:false,async readSector(sector,s){s.throwIfAborted();return image.subarray(sector*512,(sector+1)*512);},async writeSector(sector,data,s){s.throwIfAborted();writes++;image.set(data,sector*512);},async sync(s){s.throwIfAborted();}};return {device,image,get writes(){return writes;}};
}
