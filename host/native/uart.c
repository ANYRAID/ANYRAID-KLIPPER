// Linux termios2 supports firmware-specific rates such as 250000 baud.
#include <node_api.h>
#include <asm/termbits.h>
#include <sys/ioctl.h>
#include <sys/file.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <math.h>
#include <string.h>
#include <stdio.h>
static napi_value fail(napi_env env,const char *operation){char message[256];snprintf(message,sizeof(message),"%s: %s",operation,strerror(errno));napi_throw_error(env,NULL,message);return NULL;}
static int baud_value(napi_env env,napi_value value,unsigned *baud){double n;if(napi_get_value_double(env,value,&n)!=napi_ok||!isfinite(n)||n<1||n>4000000||floor(n)!=n){napi_throw_range_error(env,NULL,"Invalid UART baud rate");return 0;}*baud=(unsigned)n;return 1;}
static int speed(int fd,unsigned baud){struct termios2 t;if(ioctl(fd,TCGETS2,&t))return -1;t.c_cflag=(t.c_cflag&~(CBAUD|CIBAUD))|BOTHER;t.c_ispeed=t.c_ospeed=baud;if(ioctl(fd,TCSETS2,&t))return -1;if(ioctl(fd,TCGETS2,&t))return -1;if(t.c_ispeed!=baud||t.c_ospeed!=baud){errno=EINVAL;return -1;}return 0;}
static napi_value open_uart(napi_env env,napi_callback_info info){
 size_t n=3,len=0; napi_value a[3],result;char path[4096];unsigned baud;bool rts;
 if(napi_get_cb_info(env,info,&n,a,NULL,NULL)!=napi_ok||n!=3||napi_get_value_string_utf8(env,a[0],NULL,0,&len)!=napi_ok||!len||len>=sizeof(path)){napi_throw_type_error(env,NULL,"Invalid UART path");return NULL;}
 if(napi_get_value_string_utf8(env,a[0],path,sizeof(path),&len)!=napi_ok||strlen(path)!=len||path[0]!='/'){napi_throw_type_error(env,NULL,"UART path must be absolute without NUL");return NULL;}
 if(!baud_value(env,a[1],&baud))return NULL;
 if(napi_get_value_bool(env,a[2],&rts)!=napi_ok){napi_throw_type_error(env,NULL,"Invalid UART RTS");return NULL;}
 int fd=open(path,O_RDWR|O_NOCTTY|O_NONBLOCK|O_CLOEXEC);if(fd<0)return fail(env,"Open UART");
 const char *operation="Lock UART";if(flock(fd,LOCK_EX|LOCK_NB))goto error;
 struct termios2 t;operation="Read UART termios";if(ioctl(fd,TCGETS2,&t))goto error;
 t.c_iflag=0;t.c_oflag=0;t.c_lflag=0;t.c_cflag&=~(CSIZE|PARENB|PARODD|CSTOPB|CRTSCTS|HUPCL);t.c_cflag|=CS8|CREAD|CLOCAL;t.c_cc[VMIN]=0;t.c_cc[VTIME]=0;
 operation="Configure UART raw mode";if(ioctl(fd,TCSETS2,&t))goto error;
 operation="Set UART baud";if(speed(fd,baud))goto error;
 int bits=TIOCM_DTR;operation="Set UART modem lines";
 if(ioctl(fd,TIOCMBIS,&bits)&&errno!=ENOTTY&&errno!=EINVAL)goto error;
 bits=TIOCM_RTS;if(ioctl(fd,rts?TIOCMBIS:TIOCMBIC,&bits)&&errno!=ENOTTY&&errno!=EINVAL)goto error;
 operation="Flush UART input";if(ioctl(fd,TCFLSH,TCIFLUSH))goto error;
 if(napi_create_int32(env,fd,&result)!=napi_ok){close(fd);napi_throw_error(env,NULL,"Node-API failure");return NULL;}return result;
 error:{int saved=errno;close(fd);errno=saved;return fail(env,operation);}
}
static napi_value set_baud(napi_env env,napi_callback_info info){size_t n=2;napi_value a[2],result;double fd;unsigned baud;if(napi_get_cb_info(env,info,&n,a,NULL,NULL)!=napi_ok||n!=2||napi_get_value_double(env,a[0],&fd)!=napi_ok||!isfinite(fd)||fd<0||fd>2147483647||floor(fd)!=fd){napi_throw_type_error(env,NULL,"Invalid UART fd");return NULL;}if(!baud_value(env,a[1],&baud))return NULL;if(speed((int)fd,baud))return fail(env,"Set UART baud");napi_get_undefined(env,&result);return result;}
napi_status uart_exports(napi_env env,napi_value exports){napi_property_descriptor d[]={{"openUART",NULL,open_uart,NULL,NULL,NULL,napi_default,NULL},{"setUARTBaud",NULL,set_baud,NULL,NULL,NULL,napi_default,NULL}};return napi_define_properties(env,exports,2,d);}
