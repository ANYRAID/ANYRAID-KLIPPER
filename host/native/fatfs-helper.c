// Isolated FatFs process bridge. GPL-3.0-or-later.
// Wire header: opcode byte, little-endian uint32 payload length.
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ff.h"
#include "diskio.h"
#define LIMIT (64u*1024u*1024u)
static FATFS filesystem;
static uint32_t sectors, timestamp;
static int mounted, protected_disk, failed;
static uint32_t u32(const uint8_t *b){return (uint32_t)b[0]|(uint32_t)b[1]<<8|(uint32_t)b[2]<<16|(uint32_t)b[3]<<24;}
static void put32(uint8_t *b,uint32_t v){for(int i=0;i<4;i++)b[i]=(uint8_t)(v>>(8*i));}
static int read_exact(void *p,size_t n){return !n||fread(p,1,n,stdin)==n;}
static int frame(uint8_t op,const void *p,uint32_t n){uint8_t h[5]={op};put32(h+1,n);return fwrite(h,1,5,stdout)==5&&(!n||fwrite(p,1,n,stdout)==n)&&fflush(stdout)==0;}
static int response(void *data,uint32_t length){uint8_t h[5];if(!read_exact(h,5)||h[0]!='='||u32(h+1)!=length||!read_exact(data,length)){failed=1;return 0;}return 1;}
DSTATUS disk_status(BYTE drive){return drive||!mounted||failed?STA_NOINIT:protected_disk?STA_PROTECT:0;}
DSTATUS disk_initialize(BYTE drive){return disk_status(drive);}
DRESULT disk_read(BYTE drive,BYTE *buffer,LBA_t sector,UINT count){
 if(drive||failed||!count||count>128||sector>=sectors||count>sectors-sector)return RES_PARERR;
 uint8_t request[8];put32(request,sector);put32(request+4,count);
 if(!frame('r',request,8)||!response(buffer,count*512)){failed=1;return RES_ERROR;}return RES_OK;
}
DRESULT disk_write(BYTE drive,const BYTE *buffer,LBA_t sector,UINT count){
 if(protected_disk)return RES_WRPRT;
 if(drive||failed||!count||count>128||sector>=sectors||count>sectors-sector)return RES_PARERR;
 uint8_t *request=malloc(8+count*512);if(!request)return RES_ERROR;put32(request,sector);put32(request+4,count);memcpy(request+8,buffer,count*512);
 int ok=frame('w',request,8+count*512);free(request);if(!ok||!response(NULL,0)){failed=1;return RES_ERROR;}return RES_OK;
}
DRESULT disk_ioctl(BYTE drive,BYTE cmd,void *buffer){
 if(drive||failed)return RES_NOTRDY;
 if(cmd==CTRL_SYNC){if(!frame('s',NULL,0)||!response(NULL,0)){failed=1;return RES_ERROR;}return RES_OK;}
 if(cmd==GET_SECTOR_COUNT){*(LBA_t*)buffer=sectors;return RES_OK;}
 if(cmd==GET_SECTOR_SIZE){*(WORD*)buffer=512;return RES_OK;}
 if(cmd==GET_BLOCK_SIZE){*(DWORD*)buffer=1;return RES_OK;}return RES_PARERR;
}
DWORD get_fattime(void){return timestamp;}
static int error(FRESULT code){uint8_t b[4];put32(b,code);return frame('!',b,4);}
static int path_bytes(const uint8_t *data,uint32_t length,char *path){
 if(!length||length>255||memchr(data,0,length))return 0;
 memcpy(path,data,length);path[length]=0;return 1;
}
int main(void){
 uint8_t header[5];setvbuf(stdin,NULL,_IONBF,0);
 while(read_exact(header,5)){
  uint32_t length=u32(header+1);if(length>LIMIT+260)return 2;
  uint8_t *data=malloc(length?length:1);if(!data||!read_exact(data,length)){free(data);return 2;}
  FRESULT result=FR_INVALID_PARAMETER;char path[256];uint8_t op=header[0];
  if(op=='M'&&length==9&&!mounted){sectors=u32(data);protected_disk=data[4];timestamp=u32(data+5);if(sectors&&protected_disk<=1){mounted=1;result=f_mount(&filesystem,"",1);if(result!=FR_OK){mounted=0;f_mount(NULL,"",0);}}}
  else if(op=='U'&&length==0){result=f_mount(NULL,"",0);mounted=0;}
  else if(mounted&&!failed&&(op=='R'||op=='D'||op=='S')&&path_bytes(data,length,path)){
   if(op=='D')result=f_unlink(path);
   else if(op=='S'){FILINFO info;result=f_stat(path,&info);if(result==FR_OK){uint8_t b[9];put32(b,info.fsize);put32(b+4,((uint32_t)info.fdate<<16)|info.ftime);b[8]=info.fattrib;free(data);if(!frame('=',b,9))return 2;continue;}}
   else {FIL file;result=f_open(&file,path,FA_READ);if(result==FR_OK){uint32_t size=f_size(&file);uint8_t *bytes=size<=LIMIT?malloc(size?size:1):NULL;UINT got=0;if(!bytes)result=FR_NOT_ENOUGH_CORE;else{result=f_read(&file,bytes,size,&got);if(result==FR_OK&&got!=size)result=FR_DISK_ERR;}FRESULT closed=f_close(&file);if(result==FR_OK)result=closed;if(result==FR_OK){int ok=frame('=',bytes,size);free(bytes);free(data);if(!ok)return 2;continue;}free(bytes);}}
  }else if(mounted&&!failed&&op=='W'&&length>=4){uint32_t name_length=u32(data);if(name_length<=255&&length>=4+name_length&&length-4-name_length<=LIMIT&&path_bytes(data+4,name_length,path)){
   FIL file;result=f_open(&file,path,FA_WRITE|FA_CREATE_ALWAYS);if(result==FR_OK){UINT written=0;uint32_t count=length-4-name_length;result=f_write(&file,data+4+name_length,count,&written);if(result==FR_OK&&written!=count)result=FR_DENIED;FRESULT closed=f_close(&file);if(result==FR_OK)result=closed;}
  }}
  free(data);if(!(result==FR_OK?frame('=',NULL,0):error(result)))return 2;
 }
 f_mount(NULL,"",0);return 0;
}
