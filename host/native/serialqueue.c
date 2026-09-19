// Node-API bridge to the existing GPL-3.0-or-later serialqueue core.
#include <node_api.h>
#include <stdlib.h>
#include <math.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <string.h>
#include "serialqueue.h"
#include "pyhelper.h"
napi_status uart_exports(napi_env,napi_value);
#define CHECK(x) do {if((x)!=napi_ok){napi_throw_error(env,NULL,"Node-API failure");return NULL;}}while(0)
#define REJECT(s) do {napi_throw_range_error(env,NULL,s);return NULL;}while(0)
static const napi_type_tag tag={0x4179726169645351ULL,0x3236303932303031ULL};
struct handle {struct serialqueue *sq;struct command_queue *cq[128];int fd,wake[2];uint64_t last_id;unsigned pending;};
static void release(struct handle *h){if(h->sq){serialqueue_set_wake_fd(h->sq,-1);serialqueue_exit(h->sq);serialqueue_free(h->sq);h->sq=NULL;for(int i=0;i<128;i++){serialqueue_free_commandqueue(h->cq[i]);h->cq[i]=NULL;}close(h->fd);if(h->wake[0]>=0){close(h->wake[0]);close(h->wake[1]);h->wake[0]=h->wake[1]=-1;}}}
static void cleanup(napi_env env,void *data,void *hint){(void)env;(void)hint;struct handle *h=data;release(h);free(h);}
static struct handle *get(napi_env env,napi_value obj){bool match=false;struct handle *h=NULL;if(napi_check_object_type_tag(env,obj,&tag,&match)!=napi_ok||!match||napi_unwrap(env,obj,(void**)&h)!=napi_ok||!h||!h->sq){napi_throw_error(env,NULL,"Invalid or closed serial queue");return NULL;}return h;}
static int number(napi_env env,napi_value v,double *d){return napi_get_value_double(env,v,d)==napi_ok&&isfinite(*d);}
static int integer(napi_env env,napi_value v,uint64_t *d){bool exact=false;return napi_get_value_bigint_uint64(env,v,d,&exact)==napi_ok&&exact;}
static napi_value nothing(napi_env env){napi_value v;napi_get_undefined(env,&v);return v;}
static napi_value create(napi_env env,napi_callback_info info){
 size_t n=1;napi_value a[1];CHECK(napi_get_cb_info(env,info,&n,a,NULL,NULL));double fd;
 if(n!=1||!number(env,a[0],&fd)||fd<0||fd>0x7fffffff||floor(fd)!=fd)REJECT("Invalid serial file descriptor");
 int owned=fcntl((int)fd,F_DUPFD_CLOEXEC,0);if(owned<0)REJECT("Unable to duplicate serial descriptor");
 struct handle *h=calloc(1,sizeof(*h));if(!h){close(owned);REJECT("Allocation failed");}h->fd=owned;h->wake[0]=h->wake[1]=-1;
 char name[16]="anyraid-node";h->sq=serialqueue_alloc(owned,'u',0,name);if(!h->sq){close(owned);free(h);REJECT("Unable to create serial queue");}
 napi_value obj;napi_status status=napi_create_object(env,&obj);if(status==napi_ok)status=napi_type_tag_object(env,obj,&tag);if(status==napi_ok)status=napi_wrap(env,obj,h,cleanup,NULL,NULL);if(status!=napi_ok){cleanup(env,h,NULL);CHECK(status);}return obj;
}
static napi_value wake_fd(napi_env env,napi_callback_info info){
 size_t n=1;napi_value a[1];CHECK(napi_get_cb_info(env,info,&n,a,NULL,NULL));if(n!=1)REJECT("Expected queue");struct handle *h=get(env,a[0]);if(!h)return NULL;
 if(h->wake[0]>=0)REJECT("Serial wake listener already attached");
 int fds[2];if(socketpair(AF_UNIX,SOCK_STREAM|SOCK_NONBLOCK|SOCK_CLOEXEC,0,fds)<0)REJECT("Unable to create serial wake socket");
 int fd=fcntl(fds[0],F_DUPFD_CLOEXEC,0);if(fd<0){close(fds[0]);close(fds[1]);REJECT("Unable to duplicate wake socket");}
 napi_value result;napi_status status=napi_create_int32(env,fd,&result);if(status!=napi_ok){close(fd);close(fds[0]);close(fds[1]);CHECK(status);}
 h->wake[0]=fds[0];h->wake[1]=fds[1];serialqueue_set_wake_fd(h->sq,h->wake[1]);return result;
}
static napi_value close_queue(napi_env env,napi_callback_info info){size_t n=1;napi_value a[1];CHECK(napi_get_cb_info(env,info,&n,a,NULL,NULL));if(n!=1)REJECT("Expected queue");struct handle *h=get(env,a[0]);if(!h)return NULL;release(h);return nothing(env);}
static napi_value send_queue(napi_env env,napi_callback_info info){
 size_t n=6;napi_value a[6];CHECK(napi_get_cb_info(env,info,&n,a,NULL,NULL));if(n!=6)REJECT("Expected queue, payload, clocks, notification and command queue");struct handle *h=get(env,a[0]);if(!h)return NULL;
 napi_typedarray_type type;size_t len,offset;void *bytes;napi_value backing;CHECK(napi_get_typedarray_info(env,a[1],&type,&len,&bytes,&backing,&offset));bool owned=false;CHECK(napi_is_arraybuffer(env,backing,&owned));
 uint64_t min,req,id;double queue;
 if(type!=napi_uint8_array||!owned||len<1||len>59||!integer(env,a[2],&min)||!integer(env,a[3],&req)||min>MAX_CLOCK||req>MAX_CLOCK||!integer(env,a[4],&id)||id<=h->last_id||!number(env,a[5],&queue)||queue<0||queue>=128||floor(queue)!=queue)REJECT("Invalid serial message");
 if(h->pending>=4096)REJECT("Serial pending message capacity exceeded");
 if(!h->cq[(int)queue])h->cq[(int)queue]=serialqueue_alloc_commandqueue();
 serialqueue_send(h->sq,h->cq[(int)queue],bytes,(int)len,min,req,id);h->last_id=id;h->pending++;return nothing(env);
}
static uint64_t read_le64(const uint8_t *p){uint64_t n=0;for(int i=0;i<8;i++)n|=(uint64_t)p[i]<<(8*i);return n;}
static napi_value send_batch(napi_env env,napi_callback_info info){
 size_t n=5;napi_value a[5];CHECK(napi_get_cb_info(env,info,&n,a,NULL,NULL));if(n!=5)REJECT("Expected queue, packed batch, first notification, command queue and deadline");struct handle *h=get(env,a[0]);if(!h)return NULL;
 napi_typedarray_type type;size_t len,offset;void *raw;napi_value backing;CHECK(napi_get_typedarray_info(env,a[1],&type,&len,&raw,&backing,&offset));bool owned=false;CHECK(napi_is_arraybuffer(env,backing,&owned));
 uint64_t first;double queue,deadline;
 if(type!=napi_uint8_array||!owned||len<76||len%76||len/76>4096||!integer(env,a[2],&first)||first<=h->last_id||!number(env,a[3],&queue)||queue<0||queue>=128||floor(queue)!=queue||!number(env,a[4],&deadline)||deadline<0)REJECT("Invalid serial batch");
 size_t count=len/76;if(count>4096-h->pending)REJECT("Serial pending message capacity exceeded");if(count-1>UINT64_MAX-first)REJECT("Serial notification overflow");
 uint8_t *bytes=raw;
 // Validate the complete batch before allocation, queue mutation or I/O.
 for(size_t i=0;i<count;i++){uint8_t *p=bytes+i*76;if(read_le64(p)>MAX_CLOCK||read_le64(p+8)>MAX_CLOCK||p[16]<1||p[16]>59)REJECT("Invalid serial batch packet");}
 napi_value result;CHECK(napi_get_undefined(env,&result));struct list_head messages;list_init(&messages);
 for(size_t i=0;i<count;i++){uint8_t *p=bytes+i*76;struct queue_message *qm=calloc(1,sizeof(*qm));if(!qm){message_queue_free(&messages);REJECT("Serial batch allocation failed");}qm->len=p[16];memcpy(qm->msg,p+17,qm->len);qm->min_clock=read_le64(p);qm->req_clock=read_le64(p+8);qm->notify_id=first+i;list_add_tail(&qm->node,&messages);}
 if(!h->cq[(int)queue])h->cq[(int)queue]=serialqueue_alloc_commandqueue();
 if(deadline&&get_monotonic()>=deadline){message_queue_free(&messages);REJECT("Motion enqueue deadline exceeded");}
 serialqueue_send_batch(h->sq,h->cq[(int)queue],&messages);h->last_id=first+count-1;h->pending+=count;return result;
}
static napi_value pull(napi_env env,napi_callback_info info){
 size_t n=1;napi_value a[1];CHECK(napi_get_cb_info(env,info,&n,a,NULL,NULL));if(n!=1)REJECT("Expected queue");struct handle *h=get(env,a[0]);if(!h)return NULL;struct pull_queue_message p;
 int status=serialqueue_try_pull(h->sq,&p);if(!status)return nothing(env);if(status<0){napi_value v;CHECK(napi_get_null(env,&v));return v;}
 if(p.notify_id&&h->pending)h->pending--;
 napi_value obj,data,v;CHECK(napi_create_object(env,&obj));CHECK(napi_create_buffer_copy(env,p.len,p.msg,NULL,&data));CHECK(napi_set_named_property(env,obj,"data",data));
 CHECK(napi_create_double(env,p.sent_time,&v));CHECK(napi_set_named_property(env,obj,"sentTime",v));CHECK(napi_create_double(env,p.receive_time,&v));CHECK(napi_set_named_property(env,obj,"receiveTime",v));CHECK(napi_create_bigint_uint64(env,p.notify_id,&v));CHECK(napi_set_named_property(env,obj,"notifyId",v));return obj;
}
static napi_value configure(napi_env env,napi_callback_info info){size_t n=3;napi_value a[3];CHECK(napi_get_cb_info(env,info,&n,a,NULL,NULL));if(n!=3)REJECT("Expected queue, frequency and receive window");struct handle *h=get(env,a[0]);if(!h)return NULL;double freq,window;if(!number(env,a[1],&freq)||freq<0||freq>1e9||!number(env,a[2],&window)||(window!=0&&window<64)||window>65536||floor(window)!=window)REJECT("Invalid serial configuration");if(freq)serialqueue_set_wire_frequency(h->sq,freq);if(window)serialqueue_set_receive_window(h->sq,(int)window);return nothing(env);}
static napi_value estimate(napi_env env,napi_callback_info info){size_t n=4;napi_value a[4];CHECK(napi_get_cb_info(env,info,&n,a,NULL,NULL));if(n!=4)REJECT("Expected clock estimate");struct handle *h=get(env,a[0]);if(!h)return NULL;double freq,time;uint64_t clock;if(!number(env,a[1],&freq)||freq<=0||freq>1e9||!number(env,a[2],&time)||time<0||!integer(env,a[3],&clock)||clock>MAX_CLOCK)REJECT("Invalid serial clock estimate");serialqueue_set_clock_est(h->sq,freq,time,clock);return nothing(env);}
static napi_value now(napi_env env,napi_callback_info info){(void)info;napi_value v;CHECK(napi_create_double(env,get_monotonic(),&v));return v;}
static napi_value stats(napi_env env,napi_callback_info info){size_t n=1;napi_value a[1];CHECK(napi_get_cb_info(env,info,&n,a,NULL,NULL));if(n!=1)REJECT("Expected queue");struct handle *h=get(env,a[0]);if(!h)return NULL;char buf[4096];serialqueue_get_stats(h->sq,buf,sizeof(buf));napi_value v;CHECK(napi_create_string_utf8(env,buf,NAPI_AUTO_LENGTH,&v));return v;}
static napi_value init(napi_env env,napi_value exports){CHECK(uart_exports(env,exports));napi_property_descriptor d[]={
 {"sendBatch",NULL,send_batch,NULL,NULL,NULL,napi_default,NULL},
 {"wakeFd",NULL,wake_fd,NULL,NULL,NULL,napi_default,NULL},{"create",NULL,create,NULL,NULL,NULL,napi_default,NULL},{"close",NULL,close_queue,NULL,NULL,NULL,napi_default,NULL},{"send",NULL,send_queue,NULL,NULL,NULL,napi_default,NULL},{"pull",NULL,pull,NULL,NULL,NULL,napi_default,NULL},{"configure",NULL,configure,NULL,NULL,NULL,napi_default,NULL},{"estimate",NULL,estimate,NULL,NULL,NULL,napi_default,NULL},{"now",NULL,now,NULL,NULL,NULL,napi_default,NULL},{"stats",NULL,stats,NULL,NULL,NULL,napi_default,NULL}};CHECK(napi_define_properties(env,exports,sizeof(d)/sizeof(d[0]),d));return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
