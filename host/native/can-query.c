// GPL-3.0-or-later. Minimal Linux SocketCAN discovery transport.
#include <node_api.h>
#include <linux/can.h>
#include <linux/can/raw.h>
#include <net/if.h>
#include <sys/socket.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
struct channel { int fd; int sent; };
static const napi_type_tag tag={0x43414e5155455259ULL,0x3236303932323031ULL};
static napi_value fail(napi_env env,const char *op){char text[256];snprintf(text,sizeof(text),"%s: %s",op,strerror(errno));napi_throw_error(env,NULL,text);return NULL;}
static void release(napi_env env,void *data,void *hint){(void)env;(void)hint;struct channel *c=data;if(c->fd>=0)close(c->fd);free(c);}
static struct channel *get(napi_env env,napi_callback_info info){size_t n=1;napi_value a;napi_valuetype type;bool valid=false;void *p=NULL;if(napi_get_cb_info(env,info,&n,&a,NULL,NULL)!=napi_ok||n!=1||napi_typeof(env,a,&type)!=napi_ok||type!=napi_external||napi_check_object_type_tag(env,a,&tag,&valid)!=napi_ok||!valid||napi_get_value_external(env,a,&p)!=napi_ok){napi_throw_type_error(env,NULL,"Invalid CAN channel");return NULL;}return p;}
static napi_value open_channel(napi_env env,napi_callback_info info){
 size_t count=1,length=0;napi_value a,result;char name[IFNAMSIZ];
 if(napi_get_cb_info(env,info,&count,&a,NULL,NULL)!=napi_ok||count!=1||napi_get_value_string_utf8(env,a,NULL,0,&length)!=napi_ok||length==0||length>=sizeof(name)){napi_throw_type_error(env,NULL,"Invalid CAN interface name");return NULL;}
 if(napi_get_value_string_utf8(env,a,name,sizeof(name),&length)!=napi_ok||strlen(name)!=length){napi_throw_type_error(env,NULL,"Invalid CAN interface name");return NULL;}
 unsigned index=if_nametoindex(name);if(!index)return fail(env,"Find CAN interface");
 int fd=socket(PF_CAN,SOCK_RAW|SOCK_NONBLOCK|SOCK_CLOEXEC,CAN_RAW);if(fd<0)return fail(env,"Open CAN socket");
 // CAN_ERR_FLAG in can_mask selects error subscriptions, not data exclusion.
 // RAW sockets exclude error frames by default (CAN_RAW_ERR_FILTER is unset).
 struct can_filter filter={.can_id=0x3f1,.can_mask=CAN_SFF_MASK|CAN_EFF_FLAG|CAN_RTR_FLAG};
 const char *op="Filter CAN discovery responses";
 if(setsockopt(fd,SOL_CAN_RAW,CAN_RAW_FILTER,&filter,sizeof(filter)))goto error;
 struct sockaddr_can addr={.can_family=AF_CAN,.can_ifindex=(int)index};op="Bind CAN interface";
 if(bind(fd,(struct sockaddr *)&addr,sizeof(addr)))goto error;
 struct channel *c=calloc(1,sizeof(*c));op="Allocate CAN channel";if(!c)goto error;c->fd=fd;
 if(napi_create_external(env,c,release,NULL,&result)!=napi_ok){release(env,c,NULL);napi_throw_error(env,NULL,"Create CAN handle");return NULL;}
 if(napi_type_tag_object(env,result,&tag)!=napi_ok){close(fd);c->fd=-1;napi_throw_error(env,NULL,"Tag CAN handle");return NULL;}return result;
 error:{int saved=errno;close(fd);errno=saved;return fail(env,op);}
}
static napi_value send_query(napi_env env,napi_callback_info info){struct channel *c=get(env,info);if(!c)return NULL;if(c->fd<0||c->sent){napi_throw_error(env,NULL,"CAN channel closed or query already sent");return NULL;}struct can_frame frame={.can_id=0x3f0,.len=1,.data={0}};c->sent=1;ssize_t n;do{n=send(c->fd,&frame,sizeof(frame),MSG_NOSIGNAL);}while(n<0&&errno==EINTR);if(n<0)return fail(env,"Send CAN query");if(n!=sizeof(frame)){napi_throw_error(env,NULL,"Incomplete CAN query write");return NULL;}napi_value value;napi_get_undefined(env,&value);return value;}
static napi_value read_frame(napi_env env,napi_callback_info info){
 struct channel *c=get(env,info);if(!c)return NULL;if(c->fd<0){napi_throw_error(env,NULL,"CAN channel closed");return NULL;}
 struct can_frame frame;ssize_t n;do{n=recv(c->fd,&frame,sizeof(frame),MSG_DONTWAIT|MSG_TRUNC);}while(n<0&&errno==EINTR);
 napi_value result,value;if(n<0&&(errno==EAGAIN||errno==EWOULDBLOCK)){napi_get_null(env,&result);return result;}if(n<0)return fail(env,"Read CAN response");
 if(n!=sizeof(frame)||frame.len>8){napi_throw_error(env,NULL,"Invalid Classical CAN frame");return NULL;}
 if(napi_create_object(env,&result)!=napi_ok||napi_create_uint32(env,frame.can_id,&value)!=napi_ok||napi_set_named_property(env,result,"id",value)!=napi_ok||napi_create_buffer_copy(env,frame.len,frame.data,NULL,&value)!=napi_ok||napi_set_named_property(env,result,"data",value)!=napi_ok){napi_throw_error(env,NULL,"Create CAN response");return NULL;}return result;
}
static napi_value close_channel(napi_env env,napi_callback_info info){struct channel *c=get(env,info);if(!c)return NULL;if(c->fd>=0){close(c->fd);c->fd=-1;}napi_value value;napi_get_undefined(env,&value);return value;}
static napi_value init(napi_env env,napi_value exports){napi_property_descriptor d[]={{"open",NULL,open_channel,NULL,NULL,NULL,napi_default,NULL},{"sendQuery",NULL,send_query,NULL,NULL,NULL,napi_default,NULL},{"read",NULL,read_frame,NULL,NULL,NULL,napi_default,NULL},{"close",NULL,close_channel,NULL,NULL,NULL,napi_default,NULL}};if(napi_define_properties(env,exports,4,d)!=napi_ok)return NULL;return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
