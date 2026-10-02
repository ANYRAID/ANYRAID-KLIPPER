#define _GNU_SOURCE
#include <node_api.h>
#include <sys/socket.h>
#include <limits.h>
#include <math.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#define CHECK(expr) do { if ((expr)!=napi_ok) { napi_throw_error(env,NULL,"Node-API failure"); return NULL; } } while (0)
static napi_value failure(napi_env env,const char *operation){char text[256];snprintf(text,sizeof(text),"%s: %s",operation,strerror(errno));napi_throw_error(env,NULL,text);return NULL;}
static napi_value credentials(napi_env env,napi_callback_info info){
 size_t count=1;napi_value args[1],result,value;double number;
 CHECK(napi_get_cb_info(env,info,&count,args,NULL,NULL));
 if(count!=1||napi_get_value_double(env,args[0],&number)!=napi_ok||!isfinite(number)||number<0||number>INT_MAX||floor(number)!=number){napi_throw_type_error(env,NULL,"Invalid Unix socket descriptor");return NULL;}
 int fd=(int)number;struct sockaddr_storage address;socklen_t length=sizeof(address);
 if(getpeername(fd,(struct sockaddr *)&address,&length))return failure(env,"Read Unix peer address");
 if(address.ss_family!=AF_UNIX){napi_throw_type_error(env,NULL,"Peer credentials require a connected Unix socket");return NULL;}
 struct ucred peer;length=sizeof(peer);
 if(getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&peer,&length))return failure(env,"Read Unix peer credentials");
 if(length!=sizeof(peer)||peer.pid<=0){napi_throw_error(env,NULL,"Invalid kernel peer credentials");return NULL;}
 CHECK(napi_create_object(env,&result));
 CHECK(napi_create_int32(env,peer.pid,&value));CHECK(napi_set_named_property(env,result,"process_id",value));
 CHECK(napi_create_uint32(env,peer.uid,&value));CHECK(napi_set_named_property(env,result,"user_id",value));
 CHECK(napi_create_uint32(env,peer.gid,&value));CHECK(napi_set_named_property(env,result,"group_id",value));
 return result;
}
static napi_value init(napi_env env,napi_value exports){napi_property_descriptor method={"credentials",NULL,credentials,NULL,NULL,NULL,napi_default,NULL};CHECK(napi_define_properties(env,exports,1,&method));return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
