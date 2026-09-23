// Node-API ownership bridge for the existing GPL-3.0-or-later trapq core.
#include <node_api.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>
#include "trapq-handle.h"
#define CHECK(x) do { if ((x)!=napi_ok) { napi_throw_error(env,NULL,"Node-API failure"); return NULL; } } while(0)
#define REJECT(msg) do { napi_throw_range_error(env,NULL,msg); return NULL; } while(0)

static void recount(struct trap_handle *h) {
    h->nodes=0;struct move *m;
    list_for_each_entry(m,&h->q->moves,node)h->nodes++;
    list_for_each_entry(m,&h->q->history,node)h->nodes++;
}
static void cleanup(napi_env env,void *data,void *hint) {
    (void)env;(void)hint;struct trap_handle *h=data;h->owner_live=0;
    if(!h->solvers){if(h->q)trapq_free(h->q);free(h);}
}
static struct trap_handle *get(napi_env env,napi_value obj) {
    bool matches=false;struct trap_handle *h=NULL;
    if(napi_check_object_type_tag(env,obj,&trapq_tag,&matches)!=napi_ok||!matches) {
        napi_throw_type_error(env,NULL,"Invalid trapq handle");return NULL;
    }
    if(napi_unwrap(env,obj,(void**)&h)!=napi_ok||!h||!h->q) {
        napi_throw_error(env,NULL,"Trapq is closed");return NULL;
    }
    return h;
}
static napi_value create(napi_env env,napi_callback_info info) {
    (void)info;struct trap_handle *h=calloc(1,sizeof(*h));if(!h)REJECT("Allocation failed");
    h->q=trapq_alloc();h->nodes=2;h->owner_live=1;napi_value obj;
    napi_status status=napi_create_object(env,&obj);
    if(status==napi_ok)status=napi_type_tag_object(env,obj,&trapq_tag);
    if(status==napi_ok)status=napi_wrap(env,obj,h,cleanup,NULL,NULL);
    if(status!=napi_ok) {cleanup(env,h,NULL);CHECK(status);}
    return obj;
}
static napi_value append_batch(napi_env env,napi_callback_info info,int replace) {
    size_t argc=3;napi_value args[3];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));
    if(argc!=(replace?3u:2u))REJECT("Expected handle, optional replacement time and Float64Array");
    struct trap_handle *h=get(env,args[0]);if(!h)return NULL;
    double cut=h->end;
    if(replace){
        CHECK(napi_get_value_double(env,args[1],&cut));
        if(!isfinite(cut)||cut<0||cut>=1e15||cut<=h->finalized||cut>h->end)REJECT("Invalid future replacement horizon");
        for(struct solver_link *s=h->solvers;s;s=s->next)
            if(cut<=nextafter(s->generated+s->future,INFINITY))REJECT("Replacement overlaps generated filter dependencies");
    }
    napi_typedarray_type type;size_t length,offset;void *pointer;napi_value backing;
    CHECK(napi_get_typedarray_info(env,args[replace?2:1],&type,&length,&pointer,&backing,&offset));
    bool owned=false;CHECK(napi_is_arraybuffer(env,backing,&owned));
    if(type!=napi_float64_array||!owned||length%13||length>13*65536)REJECT("Invalid motion batch");
    if(h->nodes+4*(length/13)>400000)REJECT("Motion queue capacity exceeded; finalize consumed history first");
    double *data=pointer,end=cut;
    if(replace&&(!length||data[0]!=cut))REJECT("Future replacement must start at its cut time");
    // Validate the entire batch before touching native queue state.
    for(size_t i=0;i<length;i+=13) {
        double *r=data+i;for(int j=0;j<13;j++)if(!isfinite(r[j]))REJECT("Nonfinite motion value");
        if(r[0]<end||r[1]<0||r[2]<0||r[3]<0||!(r[1]+r[2]+r[3]>0))REJECT("Overlapping or invalid motion time");
        end=((r[0]+r[1])+r[2])+r[3];
        if(!isfinite(end)||end>=1e15)REJECT("Motion time overflow");
        double pos[3]={r[4],r[5],r[6]},phase_time=r[0];
        for(int phase=0;phase<3;phase++) {
            double duration=r[phase+1],velocity=phase==0?r[10]:r[11];
            if(duration>0&&phase_time+duration<=phase_time)REJECT("Motion duration below time resolution");
            phase_time+=duration;
            double acceleration=phase==0?r[12]:phase==2?-r[12]:0;
            double distance=(velocity+.5*acceleration*duration)*duration;
            if(!isfinite(distance)||!isfinite(velocity+acceleration*duration))REJECT("Motion calculation overflow");
            for(int axis=0;axis<3;axis++) {pos[axis]+=r[7+axis]*distance;if(!isfinite(pos[axis]))REJECT("Motion position overflow");}
        }
    }
    if(replace){
        // Preserve both history and the active prefix used by convolution.
        // trapq_set_position would finalize that prefix and is not suitable.
        struct move *head=list_first_entry(&h->q->moves,struct move,node);
        struct move *tail=list_last_entry(&h->q->moves,struct move,node);
        struct move *m=list_prev_entry(tail,node);
        while(m!=head){
            if(m->print_time<cut){if(m->print_time+m->move_t>cut)m->move_t=cut-m->print_time;break;}
            struct move *prev=list_prev_entry(m,node);list_del(&m->node);free(m);m=prev;
        }
        tail->print_time=0.;trapq_check_sentinels(h->q);recount(h);
    }
    for(size_t i=0;i<length;i+=13) {
        double *r=data+i;trapq_append(h->q,r[0],r[1],r[2],r[3],r[4],r[5],r[6],r[7],r[8],r[9],r[10],r[11],r[12]);
    }
    h->end=end;h->nodes+=4*(length/13);
    napi_value result;CHECK(napi_get_undefined(env,&result));return result;
}
static napi_value append(napi_env env,napi_callback_info info){return append_batch(env,info,0);}
static napi_value replace_future(napi_env env,napi_callback_info info){return append_batch(env,info,1);}
static napi_value extract(napi_env env,napi_callback_info info) {
    size_t argc=4;napi_value args[4];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));
    if(argc!=4)REJECT("Expected handle, capacity, start and end");
    struct trap_handle *h=get(env,args[0]);if(!h)return NULL;
    double count,start,end;CHECK(napi_get_value_double(env,args[1],&count));CHECK(napi_get_value_double(env,args[2],&start));CHECK(napi_get_value_double(env,args[3],&end));
    if(!isfinite(count)||count<1||count>100000||floor(count)!=count||!isfinite(start)||!isfinite(end)||start<0||end<start)REJECT("Invalid extraction bounds");
    struct pull_move *moves=calloc((size_t)count,sizeof(*moves));if(!moves)REJECT("Allocation failed");
    int n=trapq_extract_old(h->q,moves,(int)count,start,end);
    napi_value buffer,result;void *out;
    napi_status status=napi_create_arraybuffer(env,(size_t)n*10*sizeof(double),&out,&buffer);
    if(status!=napi_ok) {free(moves);CHECK(status);}
    double *rows=out;
    for(int i=0;i<n;i++) {
        struct pull_move *m=moves+i;double row[10]={m->print_time,m->move_t,m->start_v,m->accel,m->start_x,m->start_y,m->start_z,m->x_r,m->y_r,m->z_r};
        memcpy(rows+i*10,row,sizeof(row));
    }
    free(moves);CHECK(napi_create_typedarray(env,napi_float64_array,(size_t)n*10,buffer,0,&result));return result;
}
static napi_value finalize(napi_env env,napi_callback_info info) {
    size_t argc=3;napi_value args[3];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));
    if(argc!=3)REJECT("Expected handle and cleanup times");
    struct trap_handle *h=get(env,args[0]);if(!h)return NULL;
    double time,history;CHECK(napi_get_value_double(env,args[1],&time));CHECK(napi_get_value_double(env,args[2],&history));
    if(!isfinite(time)||!isfinite(history)||history<0||time<history||time>=1e15||time<h->finalized)REJECT("Invalid cleanup times");
    for(struct solver_link *s=h->solvers;s;s=s->next)if(time>(s->retention?nextafter(s->generated-s->retention,-INFINITY):s->generated))REJECT("Cannot finalize ungenerated stepper motion");
    trapq_finalize_moves(h->q,time,history);h->end=fmax(h->end,time);h->finalized=time;recount(h);
    napi_value result;CHECK(napi_get_undefined(env,&result));return result;
}
static napi_value set_position(napi_env env,napi_callback_info info) {
    size_t argc=5;napi_value args[5];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));
    if(argc!=5)REJECT("Expected handle, time and XYZ position");
    struct trap_handle *h=get(env,args[0]);if(!h)return NULL;
    double values[4];for(int i=0;i<4;i++) {
        CHECK(napi_get_value_double(env,args[i+1],&values[i]));
        if(!isfinite(values[i]))REJECT("Nonfinite position reset");
    }
    if(values[0]<h->finalized||values[0]>=1e15)REJECT("Position reset precedes finalized motion");
    if(h->solvers)REJECT("Detach steppers before resetting position");
    trapq_set_position(h->q,values[0],values[1],values[2],values[3]);
    h->end=values[0];h->finalized=values[0];recount(h);
    napi_value result;CHECK(napi_get_undefined(env,&result));return result;
}
static napi_value close_queue(napi_env env,napi_callback_info info) {
    size_t argc=1;napi_value args[1];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));
    if(argc!=1)REJECT("Expected handle");
    struct trap_handle *h=get(env,args[0]);if(!h)return NULL;
    if(h->solvers)REJECT("Detach steppers before closing motion queue");
    trapq_free(h->q);h->q=NULL;
    napi_value result;CHECK(napi_get_undefined(env,&result));return result;
}
static napi_value init(napi_env env,napi_value exports) {
    napi_property_descriptor descriptors[]={
        {"create",NULL,create,NULL,NULL,NULL,napi_default,NULL},
        {"append",NULL,append,NULL,NULL,NULL,napi_default,NULL},
        {"replaceFuture",NULL,replace_future,NULL,NULL,NULL,napi_default,NULL},
        {"extract",NULL,extract,NULL,NULL,NULL,napi_default,NULL},
        {"finalize",NULL,finalize,NULL,NULL,NULL,napi_default,NULL},
        {"setPosition",NULL,set_position,NULL,NULL,NULL,napi_default,NULL},
        {"close",NULL,close_queue,NULL,NULL,NULL,napi_default,NULL}
    };
    CHECK(napi_define_properties(env,exports,7,descriptors));return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
