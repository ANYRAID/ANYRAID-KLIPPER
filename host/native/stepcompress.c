// Node-API bridge to the unchanged GPLv3 step compression core.
#include <node_api.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <math.h>
#include "stepcompress.h"
#include "msgblock.h"
#define CHECK(x) do {if((x)!=napi_ok){napi_throw_error(env,NULL,"Node-API failure");return NULL;}}while(0)
#define REJECT(s) do {napi_throw_range_error(env,NULL,s);return NULL;}while(0)
static const napi_type_tag tag={0x4179726169645343ULL,0x323630393230ULL};
struct handle {struct stepcompress *sc;struct list_head messages;double frequency,offset,last_time;size_t pending;uint64_t total,last_clock;int failed;};
static void cleanup(napi_env env,void *data,void *hint) {
    (void)env;(void)hint;struct handle *h=data;
    if(h->sc)stepcompress_free(h->sc);
    message_queue_free(&h->messages);free(h);
}
static struct handle *get(napi_env env,napi_value value,int allow_failed) {
    bool matches=false;struct handle *h=NULL;
    if(napi_check_object_type_tag(env,value,&tag,&matches)!=napi_ok||!matches||napi_unwrap(env,value,(void**)&h)!=napi_ok||!h||!h->sc){napi_throw_error(env,NULL,"Invalid or closed step compressor");return NULL;}
    if(h->failed&&!allow_failed){napi_throw_error(env,NULL,"Step compressor failed; dispose it");return NULL;}return h;
}
static napi_value create(napi_env env,napi_callback_info info) {
    size_t argc=2;napi_value args[2];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));if(argc!=2)REJECT("Expected settings and initial clock");
    napi_typedarray_type type;size_t len,offset;void *data;napi_value backing;
    CHECK(napi_get_typedarray_info(env,args[0],&type,&len,&data,&backing,&offset));bool owned=false;CHECK(napi_is_arraybuffer(env,backing,&owned));
    if(type!=napi_float64_array||!owned||len!=7)REJECT("Invalid compressor settings");
    double *v=data;for(int i=0;i<7;i++)if(!isfinite(v[i]))REJECT("Nonfinite settings");
    if(v[0]<=0||v[0]>1e9)REJECT("Invalid MCU frequency");
    for(int i=2;i<=3;i++)if(v[i]<0||v[i]>UINT32_MAX||floor(v[i])!=v[i])REJECT("Invalid OID/error tolerance");
    for(int i=4;i<=5;i++)if(v[i]<INT32_MIN||v[i]>INT32_MAX||floor(v[i])!=v[i])REJECT("Invalid message tag");
    if(v[6]!=0&&v[6]!=1)REJECT("Invalid direction inversion");
    uint64_t clock;bool lossless;CHECK(napi_get_value_bigint_uint64(env,args[1],&clock,&lossless));
    if(!lossless||clock>9007199254740991ULL)REJECT("Clock exceeds exact time-conversion range");
    double initial=v[1]+clock/v[0];if(!isfinite(initial))REJECT("Initial time overflow");
    struct handle *h=calloc(1,sizeof(*h));if(!h)REJECT("Allocation failed");list_init(&h->messages);
    h->sc=stepcompress_alloc(&h->messages);h->frequency=v[0];h->offset=v[1];h->last_time=initial;h->last_clock=clock;
    stepcompress_fill(h->sc,(uint32_t)v[2],(uint32_t)v[3],(int32_t)v[4],(int32_t)v[5]);
    stepcompress_set_invert_sdir(h->sc,(uint32_t)v[6]);stepcompress_set_time(h->sc,v[1],v[0]);
    stepcompress_reset(h->sc,clock);
    napi_value result;napi_status status=napi_create_object(env,&result);
    if(status==napi_ok)status=napi_type_tag_object(env,result,&tag);
    if(status==napi_ok)status=napi_wrap(env,result,h,cleanup,NULL,NULL);
    if(status!=napi_ok){cleanup(env,h,NULL);CHECK(status);}return result;
}
static napi_value append(napi_env env,napi_callback_info info) {
    size_t argc=2;napi_value args[2];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));if(argc!=2)REJECT("Expected handle and steps");
    struct handle *h=get(env,args[0],0);if(!h)return NULL;
    napi_typedarray_type type;size_t len,offset;void *data;napi_value backing;
    CHECK(napi_get_typedarray_info(env,args[1],&type,&len,&data,&backing,&offset));bool owned=false;CHECK(napi_is_arraybuffer(env,backing,&owned));
    if(type!=napi_float64_array||!owned||len%3||len/3+h->pending>200000)REJECT("Invalid or over-capacity step batch");
    if(h->total>INT64_MAX-len/3)REJECT("Position accounting overflow");
    double *v=data,last=h->last_time;uint64_t last_clock=h->last_clock;
    for(size_t i=0;i<len;i+=3) {
        if((v[i]!=0&&v[i]!=1)||!isfinite(v[i+1])||!isfinite(v[i+2]))REJECT("Invalid step tuple");
        double time=v[i+1]+v[i+2];long double clock=((long double)v[i+1]+v[i+2]-h->offset)*h->frequency;
        if(!isfinite(time)||time<=last||clock<1||clock>9007199254740990.L)REJECT("Invalid step time or clock");
        uint64_t rounded=(uint64_t)floorl(clock+.5L);
        if(rounded<=last_clock)REJECT("Step separation below one MCU tick");
        last=time;last_clock=rounded;
    }
    // Validation is atomic; a failure reported by the C core poisons the handle.
    for(size_t i=0;i<len;i+=3)if(stepcompress_append(h->sc,(int)v[i],v[i+1],v[i+2])){h->failed=1;REJECT("Native step compression failed");}
    h->last_time=last;h->last_clock=last_clock;h->pending+=len/3;h->total+=len/3;
    napi_value result;CHECK(napi_get_undefined(env,&result));return result;
}
static napi_value flush(napi_env env,napi_callback_info info) {
    size_t argc=1;napi_value args[1];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));if(argc!=1)REJECT("Expected handle");
    struct handle *h=get(env,args[0],0);if(!h)return NULL;
    if(stepcompress_flush(h->sc,UINT64_MAX)){h->failed=1;REJECT("Native step flush failed");}
    napi_value result,messages,history,buffer,position;CHECK(napi_create_object(env,&result));CHECK(napi_create_array(env,&messages));
    struct queue_message *qm;uint32_t index=0;
    list_for_each_entry(qm,&h->messages,node) {
        napi_value item,bytes,min_clock,req_clock;CHECK(napi_create_object(env,&item));
        CHECK(napi_create_buffer_copy(env,qm->len,qm->msg,NULL,&bytes));CHECK(napi_set_named_property(env,item,"data",bytes));
        CHECK(napi_create_bigint_uint64(env,qm->min_clock,&min_clock));CHECK(napi_set_named_property(env,item,"minClock",min_clock));
        CHECK(napi_create_bigint_uint64(env,qm->req_clock,&req_clock));CHECK(napi_set_named_property(env,item,"reqClock",req_clock));CHECK(napi_set_element(env,messages,index++,item));
    }
    size_t cap=h->pending+1;struct pull_history_steps *rows=calloc(cap,sizeof(*rows));if(!rows)REJECT("Allocation failed");
    int count=stepcompress_extract_old(h->sc,rows,(int)cap,0,UINT64_MAX);void *out;
    napi_status status=napi_create_arraybuffer(env,(size_t)count*6*sizeof(int64_t),&out,&buffer);
    if(status!=napi_ok){free(rows);CHECK(status);}int64_t *dest=out;
    for(int i=0;i<count;i++) {
        struct pull_history_steps *r=rows+i;int64_t row[6]={(int64_t)r->first_clock,(int64_t)r->last_clock,r->start_position,r->step_count,r->interval,r->add};
        for(int j=0;j<6;j++)dest[i*6+j]=row[j];
    }
    free(rows);CHECK(napi_create_typedarray(env,napi_bigint64_array,(size_t)count*6,buffer,0,&history));
    CHECK(napi_create_bigint_int64(env,stepcompress_find_past_position(h->sc,UINT64_MAX),&position));
    CHECK(napi_set_named_property(env,result,"messages",messages));CHECK(napi_set_named_property(env,result,"history",history));CHECK(napi_set_named_property(env,result,"position",position));
    message_queue_free(&h->messages);stepcompress_history_expire(h->sc,UINT64_MAX);h->pending=0;return result;
}
static napi_value close_handle(napi_env env,napi_callback_info info) {
    size_t argc=1;napi_value args[1];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));if(argc!=1)REJECT("Expected handle");
    struct handle *h=get(env,args[0],1);if(!h)return NULL;stepcompress_free(h->sc);h->sc=NULL;message_queue_free(&h->messages);
    napi_value result;CHECK(napi_get_undefined(env,&result));return result;
}
static napi_value init(napi_env env,napi_value exports) {
    napi_property_descriptor methods[]={
      {"create",NULL,create,NULL,NULL,NULL,napi_default,NULL},{"append",NULL,append,NULL,NULL,NULL,napi_default,NULL},
      {"flush",NULL,flush,NULL,NULL,NULL,napi_default,NULL},{"close",NULL,close_handle,NULL,NULL,NULL,napi_default,NULL}};
    CHECK(napi_define_properties(env,exports,4,methods));return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
