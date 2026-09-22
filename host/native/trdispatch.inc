// Included by serialqueue.c: a group owns queue references; each queue keeps
// non-owning membership pointers so explicit close invalidates the whole group.
#include "trdispatch.h"
#define DISPATCH_MCUS 16
#define DISPATCH_GROUPS 32
struct dispatch_handle {
 struct trdispatch *td;napi_env env;unsigned count;int started;
 struct {struct handle *queue;napi_ref ref;unsigned slot,oid;} members[DISPATCH_MCUS];
};
static const napi_type_tag dispatch_tag={0x4179726169645452ULL,0x3236303932333031ULL};
static void release_dispatch(struct dispatch_handle *d){
 if(!d->td)return;
 // stop waits for every in-flight fastreader before any queue/ref is released.
 trdispatch_free(d->td);d->td=NULL;
 for(unsigned i=0;i<d->count;i++)d->members[i].queue->dispatches[d->members[i].slot]=NULL;
 for(unsigned i=0;i<d->count;i++){if(d->members[i].ref)napi_delete_reference(d->env,d->members[i].ref);d->members[i].ref=NULL;}
}
static void cleanup_dispatch(napi_env env,void *data,void *hint){(void)env;(void)hint;struct dispatch_handle *d=data;release_dispatch(d);free(d);}
static struct dispatch_handle *get_dispatch(napi_env env,napi_value obj){
 bool match=false;struct dispatch_handle *d=NULL;
 if(napi_check_object_type_tag(env,obj,&dispatch_tag,&match)!=napi_ok||!match||napi_unwrap(env,obj,(void**)&d)!=napi_ok||!d){napi_throw_error(env,NULL,"Invalid trigger dispatch");return NULL;}return d;
}
static napi_value create_dispatch(napi_env env,napi_callback_info info){
 size_t argc=1;napi_value args[1];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));bool array=false;uint32_t count;
 if(argc!=1||napi_is_array(env,args[0],&array)!=napi_ok||!array||napi_get_array_length(env,args[0],&count)!=napi_ok||!count||count>DISPATCH_MCUS)REJECT("Invalid trigger dispatch members");
 struct {struct handle *h;napi_value object;unsigned q,oid,slot;uint32_t tags[3];uint64_t clocks[4];} members[DISPATCH_MCUS];
 for(unsigned i=0;i<count;i++){
  napi_value entry,v[10];uint32_t length;CHECK(napi_get_element(env,args[0],i,&entry));
  if(napi_is_array(env,entry,&array)!=napi_ok||!array||napi_get_array_length(env,entry,&length)!=napi_ok||length!=10)REJECT("Invalid trigger dispatch member");
  for(unsigned j=0;j<10;j++)CHECK(napi_get_element(env,entry,j,&v[j]));
  struct handle *h=get(env,v[0]);if(!h)return NULL;members[i].h=h;members[i].object=v[0];
  for(unsigned j=0;j<i;j++)if(members[j].h==h)REJECT("Duplicate trigger dispatch MCU");
  double values[5];for(unsigned j=0;j<5;j++)if(!number(env,v[j+1],&values[j])||values[j]<0||floor(values[j])!=values[j]||values[j]>(j==0?127:j==1?254:4294967295.))REJECT("Invalid trigger dispatch configuration");
  members[i].q=values[0];members[i].oid=values[1];for(unsigned j=0;j<3;j++)members[i].tags[j]=values[j+2];
  for(unsigned j=0;j<4;j++)if(!integer(env,v[j+6],&members[i].clocks[j])||members[i].clocks[j]>4503599627370495ULL)REJECT("Invalid trigger dispatch clock precision");
  uint64_t *c=members[i].clocks;
  if(!c[2]||c[2]>0x7fffffff||c[1]<c[0]||c[1]-c[0]!=c[2]||!c[3]||c[3]>c[2])REJECT("Invalid trigger dispatch clock range");
  struct clock_estimate ce;serialqueue_get_clock_est(h->sq,&ce);
  if(!isfinite(ce.est_freq)||ce.est_freq<=0||!isfinite(ce.conv_time)||ce.conv_clock>4503599627370495ULL)REJECT("Trigger dispatch requires clock synchronization");
  unsigned slot=DISPATCH_GROUPS;
  for(unsigned j=0;j<DISPATCH_GROUPS;j++){
   struct dispatch_handle *other=h->dispatches[j];if(!other){if(slot==DISPATCH_GROUPS)slot=j;continue;}
   for(unsigned k=0;k<other->count;k++)if(other->members[k].queue==h&&other->members[k].oid==members[i].oid)REJECT("Trigger OID already registered");
  }
  if(slot==DISPATCH_GROUPS)REJECT("Trigger dispatch capacity exceeded");
  members[i].slot=slot;
 }
 struct dispatch_handle *d=calloc(1,sizeof(*d));if(!d)REJECT("Allocation failed");d->env=env;d->td=trdispatch_alloc();if(!d->td){free(d);REJECT("Trigger dispatch allocation failed");}
 for(unsigned i=0;i<count;i++){
  struct handle *h=members[i].h;unsigned q=members[i].q;
  if(!h->cq[q])h->cq[q]=serialqueue_alloc_commandqueue();
  struct trdispatch_mcu *m=trdispatch_mcu_alloc(d->td,h->sq,h->cq[q],members[i].oid,members[i].tags[0],members[i].tags[1],members[i].tags[2]);
  if(!m){cleanup_dispatch(env,d,NULL);REJECT("Trigger MCU allocation failed");}
  uint64_t *c=members[i].clocks;trdispatch_mcu_setup(m,c[0],c[1],c[2],c[3]);
  napi_status status=napi_create_reference(env,members[i].object,1,&d->members[i].ref);
  if(status!=napi_ok){cleanup_dispatch(env,d,NULL);CHECK(status);}
  d->members[i].queue=h;d->members[i].slot=members[i].slot;d->members[i].oid=members[i].oid;d->count++;h->dispatches[members[i].slot]=d;
 }
 napi_value obj;napi_status status=napi_create_object(env,&obj);if(status==napi_ok)status=napi_type_tag_object(env,obj,&dispatch_tag);if(status==napi_ok)status=napi_wrap(env,obj,d,cleanup_dispatch,NULL,NULL);
 if(status!=napi_ok){cleanup_dispatch(env,d,NULL);CHECK(status);}return obj;
}
static napi_value start_dispatch(napi_env env,napi_callback_info info){
 size_t n=1;napi_value a[1];CHECK(napi_get_cb_info(env,info,&n,a,NULL,NULL));if(n!=1)REJECT("Expected trigger dispatch");struct dispatch_handle *d=get_dispatch(env,a[0]);if(!d)return NULL;
 if(!d->td||d->started)REJECT("Trigger dispatch closed or already started");
 trdispatch_start(d->td,2);d->started=1;return nothing(env);
}
static napi_value close_dispatch(napi_env env,napi_callback_info info){
 size_t n=1;napi_value a[1];CHECK(napi_get_cb_info(env,info,&n,a,NULL,NULL));if(n!=1)REJECT("Expected trigger dispatch");struct dispatch_handle *d=get_dispatch(env,a[0]);if(!d)return NULL;release_dispatch(d);return nothing(env);
}
