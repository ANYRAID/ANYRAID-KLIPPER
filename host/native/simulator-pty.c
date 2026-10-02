#define _GNU_SOURCE
#include <node_api.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <termios.h>
static napi_value pair(napi_env env, napi_callback_info info) {
    (void)info;
    int master=posix_openpt(O_RDWR|O_NOCTTY|O_NONBLOCK|O_CLOEXEC),slave=-1;
    if(master<0||grantpt(master)||unlockpt(master))goto failed;
    char path[256];if(ptsname_r(master,path,sizeof(path)))goto failed;
    slave=open(path,O_RDWR|O_NOCTTY|O_NONBLOCK|O_CLOEXEC);
    struct termios attrs;
    if(slave<0||tcgetattr(slave,&attrs))goto failed;
    cfmakeraw(&attrs);attrs.c_cflag|=CLOCAL|CREAD;attrs.c_cc[VMIN]=0;attrs.c_cc[VTIME]=0;
    if(tcsetattr(slave,TCSANOW,&attrs))goto failed;
    napi_value result,value;napi_create_object(env,&result);
    napi_create_int32(env,master,&value);napi_set_named_property(env,result,"master",value);
    napi_create_int32(env,slave,&value);napi_set_named_property(env,result,"slave",value);
    napi_create_string_utf8(env,path,NAPI_AUTO_LENGTH,&value);napi_set_named_property(env,result,"path",value);
    return result;
failed:
    if(slave>=0)close(slave);
    if(master>=0)close(master);
    napi_throw_error(env,NULL,"Could not allocate raw simulator PTY");return NULL;
}
static napi_value init(napi_env env,napi_value exports) {
    napi_property_descriptor property={"pair",NULL,pair,NULL,NULL,NULL,napi_default,NULL};
    napi_define_properties(env,exports,1,&property);return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
