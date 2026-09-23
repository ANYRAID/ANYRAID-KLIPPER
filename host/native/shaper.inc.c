// Included by the Node-API stepper bridge. Uses the unchanged C shaper core.
struct stepper_kinematics *input_shaper_alloc(void);
int input_shaper_set_sk(struct stepper_kinematics *,struct stepper_kinematics *);
int input_shaper_set_shaper_params(struct stepper_kinematics *,char,int,double *,double *);
static napi_value configure_shapers(napi_env env,napi_callback_info info) {
    size_t argc=2;napi_value args[2];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));if(argc!=2)REJECT("Expected handle and shaper parameters");
    struct handle *h=get(env,args[0],0);if(!h)return NULL;
    if(!h->sk||h->mode==5||h->started||h->pending)REJECT("Configure shaping before step generation");
    napi_typedarray_type type;size_t len,offset;void *data;napi_value backing;
    CHECK(napi_get_typedarray_info(env,args[1],&type,&len,&data,&backing,&offset));bool owned=false;CHECK(napi_is_arraybuffer(env,backing,&owned));
    if(type!=napi_float64_array||!owned||len!=63)REJECT("Invalid packed shaper parameters");
    double *v=data,gain[3];
    for(int axis=0;axis<3;axis++) {
        double *p=v+axis*21;int n=(isfinite(p[0])&&p[0]>=0&&p[0]<=10)?(int)p[0]:-1;
        if(n<0||n!=p[0])REJECT("Invalid shaper pulse count");
        double sum=0,absolute=0;
        for(int i=0;i<n;i++) {
            if(!isfinite(p[i+1])||p[i+1]<-.00001||!isfinite(p[i+11])||p[i+11]<0||p[i+11]>120
               ||(i&&p[i+11]<=p[i+10]))REJECT("Invalid shaper pulse");
            sum+=p[i+1];absolute+=fabs(p[i+1]);
        }
        if(n&&(!isfinite(sum)||sum<=0||!isfinite(1./sum)||!isfinite(absolute)))REJECT("Invalid shaper gain");
        gain[axis]=n?absolute/sum:1.;
        if(!isfinite(gain[axis])||gain[axis]>2)REJECT("Shaper gain exceeds generation bound");
    }
    struct stepper_kinematics *base=h->orig_sk?h->orig_sk:h->sk,*wrapped=input_shaper_alloc();
    if(input_shaper_set_sk(wrapped,base)){free(wrapped);REJECT("Unsupported shaper kinematics");}
    for(int axis=0;axis<3;axis++) {
        double *p=v+axis*21;
        if(input_shaper_set_shaper_params(wrapped,'x'+axis,(int)p[0],p+1,p+11)){free(wrapped);REJECT("Invalid native shaper");}
    }
    if(!isfinite(wrapped->gen_steps_pre_active)||!isfinite(wrapped->gen_steps_post_active)
       ||wrapped->gen_steps_pre_active<0||wrapped->gen_steps_post_active<0){free(wrapped);REJECT("Invalid shaper scan window");}
    itersolve_set_trapq(wrapped,h->queue->q,base->step_dist);
    if(h->orig_sk)free(h->sk);else h->orig_sk=h->sk;
    h->sk=wrapped;h->link.retention=wrapped->gen_steps_post_active;h->link.future=wrapped->gen_steps_pre_active;
    for(int i=0;i<3;i++)h->gain[i]=gain[i];
    napi_value result;CHECK(napi_get_undefined(env,&result));return result;
}
static napi_value shaper_windows(napi_env env,napi_callback_info info) {
    size_t argc=1;napi_value args[1];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));if(argc!=1)REJECT("Expected handle");
    struct handle *h=get(env,args[0],0);if(!h)return NULL;if(!h->sk)REJECT("No attached solver");
    napi_value buffer,result;void *data;CHECK(napi_create_arraybuffer(env,4*sizeof(double),&data,&buffer));
    double *v=data;v[0]=h->sk->gen_steps_pre_active;v[1]=h->link.retention;
    v[3]=h->link.generated;
    v[2]=v[1]?nextafter(h->link.generated-v[1],-INFINITY):h->link.generated;
    CHECK(napi_create_typedarray(env,napi_float64_array,4,buffer,0,&result));return result;
}
static napi_value generate_shaped(napi_env env,struct handle *h,double until) {
    double start=h->link.generated,pre=h->sk->gen_steps_pre_active,post=h->sk->gen_steps_post_active;
    if(until+pre>h->queue->end)REJECT("Insufficient future motion for input shaping");
    trapq_check_sentinels(h->queue->q);
    struct move *head=list_first_entry(&h->queue->q->moves,struct move,node),*first=list_next_entry(head,node);
    // The original head sentinel has zero duration. Never convolve across it.
    double required_start=post?nextafter(first->print_time+post,INFINITY):first->print_time;
    if(start<required_start) {
        if(h->started)REJECT("Insufficient retained motion for input shaping");
        start=required_start;
    }
    if(until<start)REJECT("Insufficient initial shaper padding");
    double low=start-post,high=until+pre,max_v[3]={0,0,0},bound[3]={0,0,0};
    double lower[3]={INFINITY,INFINITY,INFINITY},upper[3]={-INFINITY,-INFINITY,-INFINITY};
    struct coord previous={0};int seen=0;size_t segments=0;
    struct move *at_start=NULL,*at_end=NULL,*m;
    list_for_each_entry(m,&h->queue->q->moves,node) {
        if(m==head)continue;
        if(m->print_time>high)break;
        double end=m->print_time+m->move_t;
        if(end<low)continue;
        double t0=fmax(low,m->print_time)-m->print_time,t1=fmin(high,end)-m->print_time;
        if(t1<t0)continue;
        if(h->mode==5&&((m->start_v||m->half_accel)&&m->axes_r.x!=1.))REJECT("Extruder requires a dedicated E queue");
        struct coord a=move_get_coord(m,t0),b=move_get_coord(m,t1),vertex=a;
        double turn=m->half_accel?-m->start_v/(2*m->half_accel):t0;
        if(turn>t0&&turn<t1)vertex=move_get_coord(m,turn);
        double speed=fmax(fabs(m->start_v+2*m->half_accel*t0),fabs(m->start_v+2*m->half_accel*t1));
        for(int axis=0;axis<3;axis++)if(h->sk->active_flags&(AF_X<<axis)) {
            if(!isfinite(a.axis[axis])||!isfinite(b.axis[axis])||(seen&&fabs(a.axis[axis]-previous.axis[axis])>h->sk->step_dist*.00001))REJECT("Discontinuous shaper source path");
            double velocity=speed*fabs(m->axes_r.axis[axis]);
            max_v[axis]=fmax(max_v[axis],velocity);
            lower[axis]=fmin(lower[axis],fmin(a.axis[axis],fmin(b.axis[axis],vertex.axis[axis])));
            upper[axis]=fmax(upper[axis],fmax(a.axis[axis],fmax(b.axis[axis],vertex.axis[axis])));
            bound[axis]=fmax(bound[axis],fabs(a.axis[axis])+velocity*(t1-t0));
            if(!h->started&&m->print_time<start&&end>h->link.generated&&velocity>0)REJECT("Initial shaper padding contains motion");
        }
        previous=b;seen=1;segments++;
        if(m->print_time<=start&&end>=start)at_start=m;
        if(m->print_time<=until&&end>=until)at_end=m;
    }
    if(!at_start||!at_end)REJECT("Incomplete shaper motion coverage");
    double velocity=0,position_bound=0;
    for(int i=0;i<3;i++){velocity+=max_v[i]*h->gain[i];position_bound+=bound[i]*h->gain[i];}
    if(h->mode==6){
        // Each shaped axis can sample different source times. Bound its whole
        // interval, including small negative weights, before applying Delta's
        // nonlinear Jacobian. Sum(normalized weights)=1, L1 norm=gain.
        double extent[3];
        for(int i=0;i<3;i++){
            double center=lower[i]*.5+upper[i]*.5;
            double radius=(upper[i]*.5-lower[i]*.5)*h->gain[i];
            // Outward margin covers coefficient normalization and accumulation.
            radius+=32*2.2204460492503131e-16*(fabs(center)+radius+1);
            extent[i]=fabs((i==0?h->tower_x:i==1?h->tower_y:0)-center)+radius;
        }
        double rad=h->arm2-extent[0]*extent[0]-extent[1]*extent[1];
        if(!isfinite(rad)||rad<=0)REJECT("Shaped Delta path outside nonsingular arm reach; shorten generation interval");
        velocity=max_v[2]*h->gain[2]+(extent[0]*max_v[0]*h->gain[0]+extent[1]*max_v[1]*h->gain[1])/sqrt(rad);
        position_bound=sqrt(h->arm2)+extent[2];
    }
    if(h->mode==5){
        // The pressure term is bounded by PA*max_velocity. The derivative of
        // the normalized triangular kernel has L1 norm 2/half_smooth_time,
        // also covering changes in pressure-advance eligibility at boundaries.
        position_bound+=h->pressure_advance*max_v[0];
        velocity+=2*h->pressure_advance*max_v[0]/pre;
    }
    double half=h->sk->step_dist*.5;
    if(!isfinite(position_bound)||position_bound+half==position_bound)REJECT("Shaped position exceeds step resolution");
    double estimate=ceil(velocity*(until-start)/h->sk->step_dist)+segments*2.+4.;
    if(!isfinite(estimate)||estimate+h->pending>200000||h->total>INT64_MAX-(uint64_t)estimate)REJECT("Shaped generation step budget exceeded");
    if(velocity/h->sk->step_dist>h->frequency*.5)REJECT("Shaped speed exceeds MCU clock resolution");
    double initial=h->sk->calc_position_cb(h->sk,at_start,start-at_start->print_time);
    double position=h->sk->calc_position_cb(h->sk,at_end,until-at_end->print_time);
    if(!isfinite(initial)||!isfinite(position)||fabs(initial-h->path_position)>half*1.000002)REJECT("Discontinuous shaped actuator path");
    h->sk->last_flush_time=start;
    // Initial padding represents a stationary machine, not previously active motion.
    if(!h->started)h->sk->last_move_time=start-post;
    if(until>start&&itersolve_generate_steps(h->sk,h->sc,until)){h->failed=1;REJECT("Native shaped generation failed");}
    h->started=1;h->path_position=position;h->link.generated=until;h->pending+=(size_t)estimate;h->total+=(uint64_t)estimate;
    napi_value result;CHECK(napi_create_double(env,itersolve_get_commanded_pos(h->sk),&result));return result;
}

static napi_value configure_pressure_advance(napi_env env,napi_callback_info info) {
    size_t argc=3;napi_value args[3];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));if(argc!=3)REJECT("Expected handle, advance and smooth time");
    struct handle *h=get(env,args[0],0);if(!h)return NULL;
    if(!h->sk||h->mode!=5||h->started||h->pending)REJECT("Configure pressure advance on an extruder before generation");
    double advance,smooth;CHECK(napi_get_value_double(env,args[1],&advance));CHECK(napi_get_value_double(env,args[2],&smooth));
    if(!isfinite(advance)||advance<0||!isfinite(smooth)||smooth<0||smooth>.2)REJECT("Invalid pressure advance settings");
    if(!advance)smooth=0;
    if(smooth&&!isfinite(1./((smooth*.5)*(smooth*.5))))REJECT("Pressure smoothing exceeds numeric resolution");
    // Replace before printing, preserving atomic configuration and freeing all
    // parameter nodes with the core's dedicated destructor.
    struct stepper_kinematics *sk=extruder_stepper_alloc();
    itersolve_set_position(sk,h->path_position,0,0);itersolve_set_trapq(sk,h->queue->q,h->sk->step_dist);
    sk->last_flush_time=h->sk->last_flush_time;sk->last_move_time=h->sk->last_move_time;
    extruder_set_pressure_advance(sk,0,advance,smooth);
    free_solver(h->sk,5);h->sk=sk;h->pressure_advance=advance;h->pa_count=1;h->pa_times[0]=0;h->pa_values[0]=advance;h->pa_last_time=0;h->link.retention=sk->gen_steps_post_active;h->link.future=sk->gen_steps_pre_active;
    napi_value result;CHECK(napi_get_undefined(env,&result));return result;
}

static napi_value schedule_pressure_advance(napi_env env,napi_callback_info info) {
    size_t argc=3;napi_value args[3];CHECK(napi_get_cb_info(env,info,&argc,args,NULL,NULL));if(argc!=3)REJECT("Expected handle, activation time and advance");
    struct handle *h=get(env,args[0],0);if(!h)return NULL;
    if(!h->sk||h->mode!=5||h->sk->gen_steps_pre_active<=0||!h->pa_count)REJECT("Scheduled pressure advance requires an enabled fixed smoothing window");
    double time,advance;CHECK(napi_get_value_double(env,args[1],&time));CHECK(napi_get_value_double(env,args[2],&advance));
    if(!isfinite(time)||time>=1e15||time<=h->pa_last_time||time<=h->link.generated+h->sk->gen_steps_pre_active
       ||!isfinite(advance)||advance<=0)REJECT("Schedule positive advance strictly after generated lookahead and previous updates");
    // Parameters are selected by source-phase START time, not by the sampled
    // point inside a phase. Keep the coefficient of a long phase still in use.
    double cutoff=h->link.generated-h->link.retention,oldest=0;
    trapq_check_sentinels(h->queue->q);struct move *m;
    list_for_each_entry(m,&h->queue->q->moves,node) {
        if(m->print_time>cutoff)break;
        if(m->move_t>0&&m->print_time+m->move_t>=cutoff){oldest=m->print_time;break;}
    }
    size_t drop=0;while(drop+1<h->pa_count&&h->pa_times[drop+1]<oldest)drop++;
    int changed=advance!=h->pa_values[h->pa_count-1];
    if(h->pa_count-drop+(size_t)changed>128)REJECT("Too many pending pressure updates; generate motion before scheduling more");
    double saved=h->sk->last_flush_time;
    h->sk->last_flush_time=fmin(saved,nextafter(oldest+h->link.retention,-INFINITY));
    extruder_set_pressure_advance(h->sk,time,advance,2*h->link.retention);
    h->sk->last_flush_time=saved;
    if(drop){memmove(h->pa_times,h->pa_times+drop,(h->pa_count-drop)*sizeof(double));memmove(h->pa_values,h->pa_values+drop,(h->pa_count-drop)*sizeof(double));h->pa_count-=drop;}
    if(changed){h->pa_times[h->pa_count]=time;h->pa_values[h->pa_count++]=advance;}
    h->pa_last_time=time;h->pressure_advance=0;
    for(size_t i=0;i<h->pa_count;i++)h->pressure_advance=fmax(h->pressure_advance,h->pa_values[i]);
    napi_value result;CHECK(napi_get_undefined(env,&result));return result;
}
