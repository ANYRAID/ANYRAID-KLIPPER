// GPL-3.0-or-later. Fixed A64 AR100 MMIO boundary; no arbitrary addresses.
// Layout and exception encoding derived from scripts/flash-ar100.py.
#include <node_api.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/sysmacros.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdint.h>
#include <string.h>
#include <errno.h>
#include <stdio.h>
#include <math.h>
#define SRAM_BASE 0x40000
#define SRAM_SIZE 0x14000
#define FW_OFFSET 0x4000
#define FW_SIZE 0x10000
#define CFG_BASE 0x1f01000
#define CFG_SIZE 0x1000
#define RESET_OFFSET 0xc00
static void barrier(void){
#if defined(__aarch64__) || defined(__arm__)
 __asm__ volatile("dsb sy" ::: "memory");
#else
 __sync_synchronize();
#endif
}
static int reset(volatile uint8_t *cfg,int asserted){
 uint8_t value=cfg[RESET_OFFSET];cfg[RESET_OFFSET]=asserted?(value&0xfe):(value|1);barrier();return (cfg[RESET_OFFSET]&1)==(asserted?0:1)?0:-1;
}
static napi_value fail(napi_env env,const char *message){napi_throw_error(env,NULL,message);return NULL;}
static int a64(void){
 char data[4096];int fd=open("/proc/device-tree/compatible",O_RDONLY|O_CLOEXEC);if(fd<0)return 0;ssize_t n=read(fd,data,sizeof(data));close(fd);if(n<=0||n==(ssize_t)sizeof(data))return 0;
 for(size_t at=0;at<(size_t)n;){size_t length=strnlen(data+at,(size_t)n-at);if(length==(size_t)n-at)return 0;if(length==strlen("allwinner,sun50i-a64")&&!memcmp(data+at,"allwinner,sun50i-a64",length))return 1;at+=length+1;}return 0;
}
static napi_value execute(napi_env env,napi_callback_info info){
 napi_value args[4],result;size_t argc=4,length=0,size=0;char mode[32];void *bytes=NULL;bool buffer=false;void *test_arg=NULL;
 if(napi_get_cb_info(env,info,&argc,args,NULL,&test_arg)!=napi_ok)return fail(env,"Invalid AR100 call");
 int testing=test_arg!=NULL,fd=-1;const char *fault="";
#ifndef AR100_TESTING
 if(testing)return fail(env,"AR100 test interface unavailable");
#endif
 if(argc!=(testing?4u:2u)||napi_get_value_string_utf8(env,args[0],mode,sizeof(mode),&length)!=napi_ok||length>=sizeof(mode)||strlen(mode)!=length||napi_is_buffer(env,args[1],&buffer)!=napi_ok||!buffer||napi_get_buffer_info(env,args[1],&bytes,&size)!=napi_ok)return fail(env,"Invalid AR100 operation or firmware buffer");
 int only_reset=!strcmp(mode,"reset"),only_halt=!strcmp(mode,"halt"),flash=!strcmp(mode,"flash"),flash_halt=!strcmp(mode,"flash-halt"),bl31=!strcmp(mode,"bl31"),bl31_halt=!strcmp(mode,"bl31-halt");
 if(!(only_reset||only_halt||flash||flash_halt||bl31||bl31_halt)||((only_reset||only_halt)?size!=0:size==0||size>FW_SIZE))return fail(env,"Invalid AR100 operation or firmware size");
 uint8_t firmware[FW_SIZE];if(size)memcpy(firmware,bytes,size);
#ifdef AR100_TESTING
 char injected[32];
 if(testing){double number;size_t fault_length=0;if(napi_get_value_double(env,args[2],&number)!=napi_ok||!isfinite(number)||number<0||number>2147483647||number!=(int)number||napi_get_value_string_utf8(env,args[3],injected,sizeof(injected),&fault_length)!=napi_ok||fault_length>=sizeof(injected)||strlen(injected)!=fault_length)return fail(env,"Invalid AR100 test descriptor");fd=fcntl((int)number,F_DUPFD_CLOEXEC,0);fault=injected;}
 else
#endif
 {if(!a64())return fail(env,"AR100 flashing requires an Allwinner A64 device tree");fd=open("/dev/mem",O_RDWR|O_SYNC|O_CLOEXEC);}
 if(fd<0)return fail(env,"Cannot open AR100 memory device");
 struct stat st;if(fstat(fd,&st)||(!testing&&(!S_ISCHR(st.st_mode)||major(st.st_rdev)!=1||minor(st.st_rdev)!=1))||(testing&&(!S_ISREG(st.st_mode)||st.st_size<CFG_BASE+CFG_SIZE))){close(fd);return fail(env,"Invalid AR100 memory device or test image");}
 if(flock(fd,LOCK_EX|LOCK_NB)){close(fd);return fail(env,"AR100 memory device is already in use");}
 volatile uint8_t *cfg=mmap(NULL,CFG_SIZE,PROT_READ|PROT_WRITE,MAP_SHARED,fd,CFG_BASE),*sram=MAP_FAILED;const char *error=NULL;int touched=0,cleanup_failed=0;
 if(cfg==MAP_FAILED){error="Cannot map AR100 reset registers";goto cleanup;}
 if(!only_reset){sram=mmap(NULL,SRAM_SIZE,PROT_READ|PROT_WRITE,MAP_SHARED,fd,SRAM_BASE);if(sram==MAP_FAILED){error="Cannot map AR100 SRAM";goto cleanup;}}
 touched=1;if(reset(cfg,1)){error="Failed to assert AR100 reset";goto cleanup;}
 if(!strcmp(fault,"after-reset")){error="Injected failure after reset";goto cleanup;}
 if(flash||flash_halt){
  for(unsigned i=0;i<14;i++){unsigned at=i*0x100;uint32_t jump=(FW_OFFSET-at)>>2;for(unsigned j=0;j<4;j++)sram[at+j]=(uint8_t)(jump>>(8*j));}barrier();
  for(unsigned i=0;i<14;i++){unsigned at=i*0x100;uint32_t jump=(FW_OFFSET-at)>>2;for(unsigned j=0;j<4;j++)if(sram[at+j]!=(uint8_t)(jump>>(8*j))){error="AR100 exception vector verification failed";goto cleanup;}}
 }
 if(!strcmp(fault,"after-vectors")){error="Injected failure after vectors";goto cleanup;}
 if(size){const int fail_verify=!strcmp(fault,"verify");const uint8_t *data=firmware;for(size_t i=0;i<size;i++)sram[FW_OFFSET+i]=data[i];barrier();if(!strcmp(fault,"after-write")){error="Injected failure after write";goto cleanup;}for(size_t i=0;i<size;i++)if(sram[FW_OFFSET+i]!=data[i]||fail_verify){error="AR100 firmware verification failed";goto cleanup;}}
 if(only_halt||flash_halt||bl31_halt){sram[FW_OFFSET]=0;barrier();if(sram[FW_OFFSET]!=0){error="AR100 halt marker verification failed";goto cleanup;}}
 if(only_reset||flash){if(!strcmp(fault,"release")){error="Injected reset release failure";goto cleanup;}if(reset(cfg,0)){error="Failed to deassert AR100 reset";goto cleanup;}}
 cleanup:
 if(error&&touched&&reset(cfg,1))cleanup_failed=1;
 if(sram!=MAP_FAILED&&munmap((void *)sram,SRAM_SIZE)&&!error)error="Cannot unmap AR100 SRAM";
 if(cfg!=MAP_FAILED&&munmap((void *)cfg,CFG_SIZE)&&!error)error="Cannot unmap AR100 reset registers";
 // Unlock explicitly: test fd duplication shares the original open description.
 flock(fd,LOCK_UN);close(fd);
 if(cleanup_failed)return fail(env,"AR100 operation failed and reset could not be confirmed; inspect hardware before retry");
 if(error)return fail(env,error);
 napi_get_undefined(env,&result);return result;
}
static napi_value init(napi_env env,napi_value exports){
 napi_property_descriptor entries[]={{"execute",NULL,execute,NULL,NULL,NULL,napi_default,NULL},
#ifdef AR100_TESTING
 {"executeTest",NULL,execute,NULL,NULL,NULL,napi_default,(void *)1},
#endif
 };if(napi_define_properties(env,exports,sizeof(entries)/sizeof(entries[0]),entries)!=napi_ok)return NULL;return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
