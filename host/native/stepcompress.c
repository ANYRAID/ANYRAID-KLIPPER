// Node-API bridge to the GPLv3 step compression core.
#include <node_api.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "stepcompress.h"
#include "msgblock.h"
#include "trapq-handle.h"
#include "itersolve.h"
struct stepper_kinematics *cartesian_stepper_alloc(char);
struct stepper_kinematics *corexy_stepper_alloc(char);
struct stepper_kinematics *corexz_stepper_alloc(char);
struct stepper_kinematics *extruder_stepper_alloc(void);
struct stepper_kinematics *delta_stepper_alloc(double,double,double);
void extruder_stepper_free(struct stepper_kinematics *);
void extruder_set_pressure_advance(struct stepper_kinematics *,double,double,double);
#define CHECK(x) do {if((x)!=napi_ok){napi_throw_error(env,NULL,"Node-API failure");return NULL;}}while(0)
#define REJECT(s) do {napi_throw_range_error(env,NULL,s);return NULL;}while(0)
static const napi_type_tag tag={0x4179726169645343ULL,0x323630393230ULL};
struct handle {struct stepcompress *sc;struct list_head messages;double frequency,offset,last_time;size_t pending;uint64_t total,last_clock,flushed_clock,position_clock;int failed;
    struct stepper_kinematics *sk;struct trap_handle *queue;napi_ref queue_ref;
    struct solver_link link;double path_position;int mode,started,position_initialized;struct stepper_kinematics *orig_sk;double gain[3],pressure_advance,arm2,tower_x,tower_y;
    double pa_times[128],pa_values[128],pa_last_time;size_t pa_count;};
static void free_solver(struct stepper_kinematics *sk,int mode) {
    if(mode==5)extruder_stepper_free(sk);else free(sk);
}
static void detach(napi_env env,struct handle *h) {
    if(h->sk){free_solver(h->sk,h->mode);h->sk=NULL;}
    if(h->orig_sk){free(h->orig_sk);h->orig_sk=NULL;}
    if(h->queue){
        struct trap_handle *q=h->queue;struct solver_link **link=&q->solvers;
        while(*link && *link!=&h->link)link=&(*link)->next;
        if(*link)*link=h->link.next;
        if(!q->owner_live&&!q->solvers){if(q->q)trapq_free(q->q);free(q);}
        h->queue=NULL;
    }
    if(h->queue_ref){napi_delete_reference(env,h->queue_ref);h->queue_ref=NULL;}
}
static void cleanup(napi_env env,void *data,void *hint) {
    (void)env;(void)hint;struct handle *h=data;
    detach(env,h);if(h->sc)stepcompress_free(h->sc);
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
    h->sc=stepcompress_alloc(&h->messages);h->frequency=v[0];h->offset=v[1];h->last_time=initial;h->last_clock=clock;h->flushed_clock=clock;
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
    if(h->sk)REJECT("Cannot mix manual steps with an attached solver");
    napi_typedarray_type type;size_t len,offset;void *data;napi_value backing;
    CHECK(napi_get_typedarray_info(env,args[1],&type,&len,&data,&backing,&offset));bool owned=false;CHECK(napi_is_arraybuffer(env,backing,&owned));
    if(type!=napi_float64_array||!owned||len%3||len/3+h->pending>200000)REJECT("Invalid or over-capacity step batch");
    if(h->total>INT64_MAX-len/3)REJECT("Position accounting overflow");
    double *v=data,last=h->last_time;uint64_t last_clock=h->last_clock>h->flushed_clock?h->last_clock:h->flushed_clock;
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
    size_t argc=2;napi_value args[2];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));if(argc<1)REJECT("Expected handle and optional flush time");
    struct handle *h=get(env,args[0],0);if(!h)return NULL;
    uint64_t clock=UINT64_MAX,barrier=h->last_clock;
    if(argc==2){
        double time;CHECK(napi_get_value_double(env,args[1],&time));double converted=(time-h->offset)*h->frequency+.5;
        if(!isfinite(time)||!isfinite(converted)||(time-h->offset)*h->frequency<0||converted>9007199254740991.|| (h->sk&&time>h->link.generated))REJECT("Invalid flush time or ungenerated motion");
        clock=barrier=(uint64_t)converted;if(clock<h->flushed_clock)REJECT("Cannot rewind flush clock");
    }else if(h->sk){double converted=(h->link.generated-h->offset)*h->frequency+.5;if(converted>=0&&converted<=9007199254740991.)barrier=(uint64_t)converted;}
    // Once mutation starts, any conversion/allocation failure prohibits replay.
    h->failed=1;
    if(stepcompress_flush(h->sc,clock)){h->failed=1;REJECT("Native step flush failed");}
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
    message_queue_free(&h->messages);stepcompress_history_expire(h->sc,UINT64_MAX);h->pending=stepcompress_pending_steps(h->sc);h->flushed_clock=barrier>h->flushed_clock?barrier:h->flushed_clock;h->failed=0;return result;
}
static napi_value calibrate_clock(napi_env env,napi_callback_info info) {
    size_t argc=4;napi_value args[4];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));if(argc!=4)REJECT("Expected handle, offset, frequency and apply flag");
    struct handle *h=get(env,args[0],0);if(!h)return NULL;
    double offset,frequency;bool apply;CHECK(napi_get_value_double(env,args[1],&offset));CHECK(napi_get_value_double(env,args[2],&frequency));CHECK(napi_get_value_bool(env,args[3],&apply));
    if(!isfinite(offset)||!isfinite(frequency)||frequency<=0||frequency>1e9)REJECT("Invalid clock calibration");
    uint64_t latest=stepcompress_latest_clock(h->sc);
    if(!isfinite(offset-.5/frequency)||!isfinite(offset+((double)latest-.5)/frequency))REJECT("Clock calibration inverse overflows");
    if(offset!=h->offset||frequency!=h->frequency){
        double time=h->sk?h->link.generated:h->last_time;
        double raw=(time-offset)*frequency,converted=raw+.5;
        if(!isfinite(converted)||raw<0||converted>9007199254740991.)REJECT("Calibration exceeds exact clock range");
        uint64_t clock=(uint64_t)converted;
        if(clock<h->flushed_clock||(h->total&&clock<=latest))REJECT("Calibration would overlap previously accepted step clocks");
    }
    napi_value result;CHECK(napi_get_undefined(env,&result));
    if(apply){stepcompress_set_time(h->sc,offset,frequency);h->offset=offset;h->frequency=frequency;}
    return result;
}
static napi_value close_handle(napi_env env,napi_callback_info info) {
    size_t argc=1;napi_value args[1];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));if(argc!=1)REJECT("Expected handle");
    struct handle *h=get(env,args[0],1);if(!h)return NULL;detach(env,h);stepcompress_free(h->sc);h->sc=NULL;message_queue_free(&h->messages);
    napi_value result;CHECK(napi_get_undefined(env,&result));return result;
}
static napi_value attach_solver(napi_env env,napi_callback_info info) {
    size_t argc=3;napi_value args[3];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));if(argc!=3)REJECT("Expected compressor, queue and solver settings");
    struct handle *h=get(env,args[0],0);if(!h)return NULL;
    if(h->sk||h->total)REJECT("Solver must attach to a fresh compressor");
    bool matches=false;CHECK(napi_check_object_type_tag(env,args[1],&trapq_tag,&matches));
    if(!matches)REJECT("Invalid motion queue ABI");
    struct trap_handle *q;
    CHECK(napi_unwrap(env,args[1],(void**)&q));if(!q||!q->q)REJECT("Closed motion queue");
    napi_typedarray_type type;size_t len,offset;void *data;napi_value backing;
    CHECK(napi_get_typedarray_info(env,args[2],&type,&len,&data,&backing,&offset));bool owned=false;CHECK(napi_is_arraybuffer(env,backing,&owned));
    if(type!=napi_float64_array||!owned||(len!=5&&len!=8))REJECT("Invalid solver settings");
    double *v=data;for(size_t i=0;i<len;i++)if(!isfinite(v[i]))REJECT("Nonfinite solver setting");
    if(v[0]<0||v[0]>8||floor(v[0])!=v[0]||v[1]<=2e-8)REJECT("Invalid kinematics or step distance");
    if((v[0]==6)!=(len==8))REJECT("Invalid Delta geometry settings");
    if(v[0]==6&&(v[5]<=0||!isfinite(v[5]*v[5])||v[5]*v[5]<=0))REJECT("Invalid Delta arm length");
    struct stepper_kinematics *sk=v[0]<3?cartesian_stepper_alloc('x'+(int)v[0]):v[0]<5?corexy_stepper_alloc(v[0]==3?'+':'-'):v[0]==5?extruder_stepper_alloc():v[0]==6?delta_stepper_alloc(v[5]*v[5],v[6],v[7]):corexz_stepper_alloc(v[0]==7?'+':'-');
    itersolve_set_position(sk,v[2],v[3],v[4]);
    if(!isfinite(sk->commanded_pos)||sk->commanded_pos+v[1]*.5==sk->commanded_pos||sk->commanded_pos-v[1]*.5==sk->commanded_pos){free_solver(sk,(int)v[0]);REJECT("Initial actuator position exceeds step resolution");}
    napi_status status=napi_create_reference(env,args[1],1,&h->queue_ref);if(status!=napi_ok){free_solver(sk,(int)v[0]);CHECK(status);}
    if(v[0]==6){h->arm2=v[5]*v[5];h->tower_x=v[6];h->tower_y=v[7];}
    h->sk=sk;h->queue=q;h->mode=(int)v[0];h->path_position=sk->commanded_pos;for(int i=0;i<3;i++)h->gain[i]=1.;
    itersolve_set_trapq(sk,q->q,v[1]);sk->last_flush_time=fmax(q->finalized,h->last_time);sk->last_move_time=sk->last_flush_time;
    h->link.generated=sk->last_flush_time;h->link.next=q->solvers;q->solvers=&h->link;
    napi_value result;CHECK(napi_get_undefined(env,&result));return result;
}
#include "shaper.inc.c"
static napi_value generate_steps(napi_env env,napi_callback_info info) {
    size_t argc=2;napi_value args[2];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));if(argc!=2)REJECT("Expected handle and generation time");
    struct handle *h=get(env,args[0],0);if(!h)return NULL;if(!h->sk)REJECT("No attached solver");
    double until;CHECK(napi_get_value_double(env,args[1],&until));double start=h->link.generated;
    if(!isfinite(until)||until<start||until>h->queue->end)REJECT("Generation must advance within queued motion");
    long double clock=((long double)until-h->offset)*h->frequency;
    if(clock<0||clock>9007199254740990.L)REJECT("Generation clock exceeds exact range");
    if(h->position_initialized){
        double observed=h->offset+(double)h->position_clock/h->frequency;
        double boundary=fmin(until,observed);
        if(start<boundary){
            trapq_check_sentinels(h->queue->q);struct move *move;
            int active=h->sk->active_flags;
            list_for_each_entry(move,&h->queue->q->moves,node){
                double begin=move->print_time-h->sk->gen_steps_pre_active;
                if(begin>=boundary)break;
                double end=move->print_time+move->move_t+h->sk->gen_steps_post_active;
                if(end<=start||!(move->start_v||move->half_accel))continue;
                if((active&AF_X&&move->axes_r.x!=0.)||(active&AF_Y&&move->axes_r.y!=0.)||(active&AF_Z&&move->axes_r.z!=0.))
                    REJECT("Motion precedes observed position history");
            }
        }
    }
    if(h->orig_sk||(h->mode==5&&h->sk->gen_steps_pre_active>0))return generate_shaped(env,h,until);
    double position=h->path_position;size_t estimate=0;
    trapq_check_sentinels(h->queue->q);struct move *m;
    list_for_each_entry(m,&h->queue->q->moves,node) {
        if(m->print_time>=until)break;
        double begin=fmax(start,m->print_time),end=fmin(until,m->print_time+m->move_t);
        if(end<=begin)continue;
        if(h->mode==5&&((m->start_v||m->half_accel)&&m->axes_r.x!=1.))REJECT("Extruder requires a dedicated E queue");
        double t0=begin-m->print_time,t1=end-m->print_time;
        double p0=h->sk->calc_position_cb(h->sk,m,t0),p1=h->sk->calc_position_cb(h->sk,m,t1);
        if(!isfinite(p0)||!isfinite(p1)||fabs(p0-position)>h->sk->step_dist*.500001)REJECT("Discontinuous actuator path");
        double half_step=h->sk->step_dist*.5;
        if(p0+half_step==p0||p0-half_step==p0||p1+half_step==p1||p1-half_step==p1)REJECT("Actuator position exceeds step resolution");
        double ratio=h->mode==5?1.:h->mode<3?fabs(m->axes_r.axis[h->mode]):fabs(m->axes_r.x)+(h->mode>=7?fabs(m->axes_r.z):fabs(m->axes_r.y));
        double velocity=fmax(fabs(m->start_v+2*m->half_accel*t0),fabs(m->start_v+2*m->half_accel*t1))*ratio;
        if(h->mode==6){
            // Distance along a quadratic segment can turn internally. Evaluate
            // that vertex as well as both ends before bounding the Jacobian.
            struct coord a=move_get_coord(m,t0),b=move_get_coord(m,t1),c=a;
            double turn=m->half_accel?-m->start_v/(2*m->half_accel):t0;
            if(turn>t0&&turn<t1)c=move_get_coord(m,turn);
            double dx=fmax(fabs(h->tower_x-a.x),fmax(fabs(h->tower_x-b.x),fabs(h->tower_x-c.x)));
            double dy=fmax(fabs(h->tower_y-a.y),fmax(fabs(h->tower_y-b.y),fabs(h->tower_y-c.y)));
            double ax=h->tower_x-a.x,ay=h->tower_y-a.y,bx=h->tower_x-b.x,by=h->tower_y-b.y,cx=h->tower_x-c.x,cy=h->tower_y-c.y;
            double rad=h->arm2-fmax(ax*ax+ay*ay,fmax(bx*bx+by*by,cx*cx+cy*cy));
            if(!isfinite(rad)||rad<=0)REJECT("Delta path outside nonsingular arm reach");
            double jac=fabs(m->axes_r.z)+(dx*fabs(m->axes_r.x)+dy*fabs(m->axes_r.y))/sqrt(rad);
            velocity=fmax(fabs(m->start_v+2*m->half_accel*t0),fabs(m->start_v+2*m->half_accel*t1))*jac;
        }
        double steps=ceil(velocity*(end-begin)/h->sk->step_dist)+2.;
        if(!isfinite(steps)||steps>200000||steps+estimate+h->pending>200000)REJECT("Generation step budget exceeded; use a smaller interval or flush");
        if(velocity/h->sk->step_dist>h->frequency*.5)REJECT("Stepper speed exceeds MCU clock resolution");
        estimate+=(size_t)steps;position=p1;
    }
    if(h->total>INT64_MAX-estimate)REJECT("Position accounting overflow");
    if(until>start&&itersolve_generate_steps(h->sk,h->sc,until)){h->failed=1;REJECT("Native step generation failed");}
    h->started=1;h->path_position=position;h->link.generated=until;h->pending+=estimate;h->total+=estimate;
    napi_value result;CHECK(napi_create_double(env,itersolve_get_commanded_pos(h->sk),&result));return result;
}
static napi_value commanded_position(napi_env env,napi_callback_info info){
 size_t argc=1;napi_value args[1];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));if(argc!=1)REJECT("Expected handle");
 struct handle *h=get(env,args[0],0);if(!h)return NULL;if(!h->sk)REJECT("No attached solver");
 napi_value result;CHECK(napi_create_double(env,itersolve_get_commanded_pos(h->sk),&result));return result;
}
static napi_value coordinate_position(napi_env env,napi_callback_info info){
 size_t argc=4;napi_value args[4];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));if(argc!=4)REJECT("Expected handle and XYZ coordinates");
 struct handle *h=get(env,args[0],0);if(!h)return NULL;if(!h->sk)REJECT("No attached solver");
 double xyz[3];for(int i=0;i<3;i++){CHECK(napi_get_value_double(env,args[i+1],&xyz[i]));if(!isfinite(xyz[i]))REJECT("Invalid actuator coordinate");}
 double position=itersolve_calc_position_from_coord(h->sk,xyz[0],xyz[1],xyz[2]);if(!isfinite(position))REJECT("Unreachable actuator coordinate");
 napi_value result;CHECK(napi_create_double(env,position,&result));return result;
}
static napi_value initialize_position(napi_env env,napi_callback_info info){
 size_t argc=3;napi_value args[3];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));if(argc!=3)REJECT("Expected handle, clock and position");struct handle *h=get(env,args[0],0);if(!h)return NULL;
 uint64_t clock;int64_t position;bool exact_clock=false,exact_position=false;
 CHECK(napi_get_value_bigint_uint64(env,args[1],&clock,&exact_clock));CHECK(napi_get_value_bigint_int64(env,args[2],&position,&exact_position));
 if(!exact_clock||clock>9007199254740991ULL||clock<h->flushed_clock||!exact_position||position>4503599627370495LL||position< -4503599627370495LL)REJECT("Invalid initial position or history clock");
 if(h->position_initialized||h->started||h->total||h->pending||!list_empty(&h->messages))REJECT("Position initialization requires an unused compressor");
 h->failed=1;if(stepcompress_set_last_position(h->sc,clock,position))REJECT("Native position initialization failed");h->position_initialized=1;h->position_clock=clock;h->flushed_clock=clock;
 napi_value result;CHECK(napi_get_undefined(env,&result));h->failed=0;return result;
}
static napi_value init(napi_env env,napi_value exports) {
    napi_property_descriptor methods[]={
      {"create",NULL,create,NULL,NULL,NULL,napi_default,NULL},{"append",NULL,append,NULL,NULL,NULL,napi_default,NULL},
      {"attachSolver",NULL,attach_solver,NULL,NULL,NULL,napi_default,NULL},{"generate",NULL,generate_steps,NULL,NULL,NULL,napi_default,NULL},
      {"configurePressureAdvance",NULL,configure_pressure_advance,NULL,NULL,NULL,napi_default,NULL},
      {"schedulePressureAdvance",NULL,schedule_pressure_advance,NULL,NULL,NULL,napi_default,NULL},
      {"setPressureAdvanceAtTail",NULL,set_pressure_advance_at_tail,NULL,NULL,NULL,napi_default,NULL},
      {"cancelPressureAdvanceAfter",NULL,cancel_pressure_advance_after,NULL,NULL,NULL,napi_default,NULL},
      {"configureShapers",NULL,configure_shapers,NULL,NULL,NULL,napi_default,NULL},{"windows",NULL,shaper_windows,NULL,NULL,NULL,napi_default,NULL},
      {"commandedPosition",NULL,commanded_position,NULL,NULL,NULL,napi_default,NULL},
      {"coordinatePosition",NULL,coordinate_position,NULL,NULL,NULL,napi_default,NULL},
      {"initializePosition",NULL,initialize_position,NULL,NULL,NULL,napi_default,NULL},{"calibrateClock",NULL,calibrate_clock,NULL,NULL,NULL,napi_default,NULL},
      {"flush",NULL,flush,NULL,NULL,NULL,napi_default,NULL},{"close",NULL,close_handle,NULL,NULL,NULL,napi_default,NULL}};
    CHECK(napi_define_properties(env,exports,16,methods));return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
