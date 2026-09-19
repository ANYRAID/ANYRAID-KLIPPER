#define _GNU_SOURCE
#include <node_api.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <asm/termbits.h>
#include <sys/ioctl.h>
static napi_value pair(napi_env e,napi_callback_info i){(void)i;int fd=posix_openpt(O_RDWR|O_NOCTTY|O_NONBLOCK|O_CLOEXEC);if(fd<0||grantpt(fd)||unlockpt(fd)){if(fd>=0)close(fd);napi_throw_error(e,NULL,"PTY allocation failed");return NULL;}napi_value o,v;napi_create_object(e,&o);napi_create_int32(e,fd,&v);napi_set_named_property(e,o,"fd",v);napi_create_string_utf8(e,ptsname(fd),NAPI_AUTO_LENGTH,&v);napi_set_named_property(e,o,"path",v);return o;}
static napi_value inspect(napi_env e,napi_callback_info i){size_t n=1;napi_value a[1],o,v;char path[256];napi_get_cb_info(e,i,&n,a,NULL,NULL);napi_get_value_string_utf8(e,a[0],path,sizeof(path),NULL);int fd=open(path,O_RDWR|O_NOCTTY|O_NONBLOCK|O_CLOEXEC);struct termios2 t;if(fd<0||ioctl(fd,TCGETS2,&t)){if(fd>=0)close(fd);napi_throw_error(e,NULL,"PTY inspection failed");return NULL;}close(fd);napi_create_object(e,&o);
#define FIELD(name,value) napi_create_uint32(e,value,&v);napi_set_named_property(e,o,name,v)
 FIELD("baud",t.c_ospeed);FIELD("inputBaud",t.c_ispeed);FIELD("inputFlags",t.c_iflag);FIELD("outputFlags",t.c_oflag);FIELD("localFlags",t.c_lflag);FIELD("vmin",t.c_cc[VMIN]);FIELD("vtime",t.c_cc[VTIME]);FIELD("stopBits",!!(t.c_cflag&CSTOPB));FIELD("parity",!!(t.c_cflag&PARENB));FIELD("flow",!!(t.c_cflag&CRTSCTS));FIELD("hupcl",!!(t.c_cflag&HUPCL));FIELD("bits",(t.c_cflag&CSIZE)==CS8?8:0);return o;}
static napi_value init(napi_env e,napi_value x){napi_property_descriptor d[]={{"pair",NULL,pair,NULL,NULL,NULL,napi_default,NULL},{"inspect",NULL,inspect,NULL,NULL,NULL,napi_default,NULL}};napi_define_properties(e,x,2,d);return x;}NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
