#define main stepper_stop_baseline_main
#include "test.c"
#undef main

int main(void) {
    // Discriminating captured command: first pulse2601027 > stop2504434.
    command_config_stepper((uint32_t[]){2,4,5,1,1});
    command_config_trsync((uint32_t[]){9});
    struct stepper *clocked=objects[2];
    clocked->position=-(POSITION_BIAS-24);
    command_reset_step_clock((uint32_t[]){2,2598527});
    command_trsync_start((uint32_t[]){9,2502934,1000,4});
    command_stepper_stop_on_trigger((uint32_t[]){2,9});
    command_queue_step((uint32_t[]){2,2500,20,0});
    int32_t before_future=position(clocked);
    assert(before_future==-24 && clocked->time.waketime==2601027);
    command_trsync_trigger((uint32_t[]){9,1});
    assert(position(clocked)==-24 && clocked->count==0);
    int32_t after_future=position(clocked);

    // Execute exactly the C scheduled events <=2504434, including unsteps.
    command_reset_step_clock((uint32_t[]){2,2498000});
    command_trsync_start((uint32_t[]){9,2498000,1000,4});
    command_stepper_stop_on_trigger((uint32_t[]){2,9});
    command_queue_step((uint32_t[]){2,2500,20,(uint32_t)-10});
    for(int n=0;clocked->count
        && (int32_t)(clocked->time.waketime-2504434)<=0;n++) {
        assert(n<100); irqstatus_t flag=irq_save();
        if(clocked->time.func(&clocked->time)==SF_DONE)
            sched_del_timer(&clocked->time);
        irq_restore(flag);
    }
    assert(position(clocked)==-26); //2500500 and2502990;2505470 is future.
    command_trsync_trigger((uint32_t[]){9,1});
    assert(position(clocked)==-26 && clocked->count==0);
    int32_t after_partial=position(clocked);

    // Preserve32-bit scheduling across wrap without counting future pulses.
    command_reset_step_clock((uint32_t[]){2,4294966796u});
    command_trsync_start((uint32_t[]){9,4294966796u,1000,4});
    command_stepper_stop_on_trigger((uint32_t[]){2,9});
    command_queue_step((uint32_t[]){2,250,4,0});
    for(int n=0;clocked->count
        && (int32_t)(clocked->time.waketime-4294967246u)<=0;n++) {
        assert(n<100); irqstatus_t flag=irq_save();
        if(clocked->time.func(&clocked->time)==SF_DONE)
            sched_del_timer(&clocked->time);
        irq_restore(flag);
    }
    assert(position(clocked)==-27); //only first4294967046 pulse before stop.
    command_trsync_trigger((uint32_t[]){9,1});
    assert(position(clocked)==-27 && clocked->count==0);
    printf("{\"capturedFutureBefore\":%d,\"capturedFutureAfterStop\":%d,"
           "\"partialNegativeAdd\":%d,\"wrapAfterStop\":%d,"
           "\"receiveOnlyWrong\":-44}\n",
           before_future,after_future,after_partial,position(clocked));

    assert(allocated==freed);
    for(int i=0;i<256;i++)free(objects[i]);
    return 0;
}
