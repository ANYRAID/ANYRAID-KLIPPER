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
#include <assert.h>
static int step,fail_step,closed;
static int next(void){
 int current=step++;
 if(current==fail_step){
 errno=EIO;
 return -1;

}return 0;

}
static int fake_open(const char *path,int flags,...){
 assert(!strcmp(path,"/mock"));
 assert(flags==(O_RDONLY|O_NOCTTY|O_NONBLOCK|O_CLOEXEC));
 return next()<0?-1:42;

}
static int fake_flock(int fd,int flags){
 assert(fd==42&&flags==(LOCK_EX|LOCK_NB));
 return next();

}
static int fake_close(int fd){assert(fd==42);closed++;return next();}
static int fake_ioctl(int fd,unsigned long request,void *arg){
 assert(fd==42);
 if(request==TIOCMBIS||request==TIOCMBIC){
 assert(*(int*)arg==TIOCM_DTR);
 assert(step==(request==TIOCMBIS?2:5));

}
 else if(request==TCGETS2){
 assert(step==3);
 struct termios2 *t=arg;
 memset(t,0,sizeof(*t));
 t->c_cflag=CS8|CREAD|CLOCAL|B115200|HUPCL;
 t->c_iflag=17;
 t->c_oflag=18;
 t->c_lflag=19;
 t->c_cc[VMIN]=7;

}
 else if(request==TCSETS2){
 assert(step==4);
 struct termios2 *t=arg;
 assert(t->c_cflag==(CS8|CREAD|CLOCAL|B1200|HUPCL));
 assert(t->c_ispeed==1200&&t->c_ospeed==1200);
 assert(t->c_iflag==17&&t->c_oflag==18&&t->c_lflag==19&&t->c_cc[VMIN]==7);

}
 else assert(0);
 return next();
}
#define open fake_open
#define flock fake_flock
#define close fake_close
#define ioctl fake_ioctl
#include "../../native/uart.c"
#undef open
#undef flock
#undef close
#undef ioctl
static napi_value
configure(napi_env env,napi_callback_info info){
 size_t count=1;
 napi_value arg,result;
 napi_get_cb_info(env,info,&count,&arg,NULL,NULL);
 napi_get_value_int32(env,arg,&fail_step);
 step=closed=0;
 napi_get_undefined(env,&result);
 return result;

}
static napi_value
stats(napi_env env,napi_callback_info info){
 (void)info;
 napi_value out,v;
 napi_create_object(env,&out);
 napi_create_int32(env,step,&v);
 napi_set_named_property(env,out,"steps",v);
 napi_create_int32(env,closed,&v);
 napi_set_named_property(env,out,"closed",v);
 return out;

}
static napi_value init(napi_env env,napi_value exports){
 uart_exports(env,exports);
 napi_property_descriptor d[]={
 {
 "configure",NULL,configure,NULL,NULL,NULL,napi_default,NULL
},{
 "stats",NULL,stats,NULL,NULL,NULL,napi_default,NULL
}
};
 napi_define_properties(env,exports,2,d);
 return exports;

}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
