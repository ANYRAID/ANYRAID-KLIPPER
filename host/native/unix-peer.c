#define _GNU_SOURCE
#include <node_api.h>
#include <sys/socket.h>
#include <limits.h>
#include <math.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
#include <pwd.h>
#include <unistd.h>
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
/* Use NSS, including configured directory services, rather than parsing only
 * /etc/passwd or launching getent. Configuration startup owns this lookup. */
static napi_value user_home(napi_env env,napi_callback_info info){
 size_t count=1,length=0;napi_value args[1],result;char *name=NULL;
 CHECK(napi_get_cb_info(env,info,&count,args,NULL,NULL));
 if(count){
  if(napi_get_value_string_utf8(env,args[0],NULL,0,&length)!=napi_ok){napi_throw_type_error(env,NULL,"Invalid Unix user name");return NULL;}
  name=malloc(length+1);if(!name){napi_throw_error(env,NULL,"Unix user lookup allocation failed");return NULL;}
  if(napi_get_value_string_utf8(env,args[0],name,length+1,&length)!=napi_ok||strlen(name)!=length){free(name);napi_throw_type_error(env,NULL,"Invalid Unix user name");return NULL;}
 }
 long initial=sysconf(_SC_GETPW_R_SIZE_MAX);size_t size=initial>0?(size_t)initial:1024;
 char *buffer=NULL;struct passwd entry,*found=NULL;int code;
 for(;;){
  char *next=realloc(buffer,size);if(!next){free(buffer);free(name);napi_throw_error(env,NULL,"Unix user lookup allocation failed");return NULL;}buffer=next;
  code=name?getpwnam_r(name,&entry,buffer,size,&found):getpwuid_r(getuid(),&entry,buffer,size,&found);
  if(code!=ERANGE)break;
  if(size>SIZE_MAX/2){free(buffer);free(name);napi_throw_error(env,NULL,"Unix user lookup allocation failed");return NULL;}size*=2;
 }
 free(name);
 if(code){free(buffer);napi_throw_error(env,NULL,"Unix user lookup failed");return NULL;}
 napi_status status=found?napi_create_string_utf8(env,found->pw_dir,NAPI_AUTO_LENGTH,&result):napi_get_null(env,&result);
 free(buffer);CHECK(status);return result;
}
static napi_value init(napi_env env,napi_value exports){napi_property_descriptor methods[]={
 {"credentials",NULL,credentials,NULL,NULL,NULL,napi_default,NULL},
 {"userHome",NULL,user_home,NULL,NULL,NULL,napi_default,NULL}
 };CHECK(napi_define_properties(env,exports,2,methods));return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
