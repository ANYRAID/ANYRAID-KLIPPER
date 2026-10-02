// Execute actual firmware output handlers with deterministic GPIO/timer stubs.
#include <assert.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#define __SCHED_H
#define __COMMAND_H
#define DECL_COMMAND(func, format)
#define DECL_SHUTDOWN(func)
struct timer { struct timer *next; uint_fast8_t (*func)(struct timer *);
        uint32_t waketime; };
enum { SF_DONE=0, SF_RESCHEDULE=1 };
static jmp_buf failure;
static const char *last_error;
#define shutdown(message) do { last_error = message; longjmp(failure, 1); } \
        while (0)
uint8_t test_irq=1;
uint32_t test_pins[256];
static struct timer *timers[256];
static void sched_add_timer(struct timer *timer) {
    for (int i=0; i<256; i++) if (!timers[i] || timers[i]==timer) {
        timers[i]=timer; return; }
    assert(0);
}
static void sched_del_timer(struct timer *timer) { for (int i=0; i<256; i++) if
        (timers[i]==timer) timers[i]=NULL; }
#include "../../../../src/gpiocmds.c"
#include "../../../../src/pwmcmds.c"
static void *objects[256], *types[256];
static int allocated, freed;
void *oid_alloc(uint8_t oid, void *type, uint16_t size) { assert(!objects[oid]);
        types[oid]=type; return objects[oid]=calloc(1,size); }
void *oid_lookup(uint8_t oid, void *type) { assert(objects[oid] &&
        types[oid]==type); return objects[oid]; }
void *oid_next(uint8_t *i, void *type) {
    for (int n=(uint8_t)(*i+1); n<256; n++) {
        if (types[n]==type) { *i=n; return objects[n]; }
    }
    return NULL;
}
void *move_alloc(void) { allocated++; return calloc(1,128); }
void move_free(void *node) { assert(!test_irq); freed++; free(node); }
int move_queue_empty(struct move_queue_head *head) { return !head->first; }
struct move_node *move_queue_first(struct move_queue_head *head) { return
        head->first; }
struct move_node *move_queue_pop(struct move_queue_head *head) { struct
        move_node *node=head->first; head->first=node->next; return node; }
int move_queue_push(struct move_node *node, struct move_queue_head *head) {
    node->next=NULL;
    int first=!head->first;
    if (first) head->first=node;
    else head->last->next=node;
    head->last=node;
    return first;
}
void move_queue_clear(struct move_queue_head *head) { head->first=NULL; }
void move_queue_setup(struct move_queue_head *head, int size) { (void)size;
        head->first=head->last=NULL; }
static void run_timer(struct timer *timer) {
    irqstatus_t flag=irq_save();
    if (timer->func(timer)==SF_DONE) sched_del_timer(timer);
    irq_restore(flag);
}
#define FAILS(command) do { if (!setjmp(failure)) { command; \
        assert(!"expected firmware shutdown"); } test_irq=1; \
        assert(last_error); } while (0)
static double milliseconds(void) {
    struct timespec value; assert(clock_gettime(CLOCK_MONOTONIC, &value)==0);
    return value.tv_sec*1000. + value.tv_nsec/1000000.;
}
static int benchmark(void) {
    for (int oid=1; oid<=4; oid++) {
        if (oid%2) {
            command_config_digital_out((uint32_t[]){oid,oid,0,0,0});
            command_set_digital_out_pwm_cycle((uint32_t[]){oid,100});
        } else command_config_pwm_out((uint32_t[]){oid,oid,100,0,0,0});
    }
    command_reset_digital_out_generation((uint32_t[]){3,1});
    command_reset_pwm_out_generation((uint32_t[]){4,1});
    puts("[");
    for (int run=0; run<13; run++) {
        double times[4];
        for (int step=0; step<4; step++) {
            int oid=run%2 ? 4-step : 1+step;
            double start=milliseconds();
            for (uint32_t i=0; i<100000; i++) {
                uint32_t args[]={oid,i*100+100,100,1};
                if (oid==1) command_queue_digital_out(args);
                else if (oid==2) command_queue_pwm_out(args);
                else if (oid==3) command_queue_digital_out_generation(args);
                else command_queue_pwm_out_generation(args);
                if (oid%2) run_timer(&((struct digital_out_s
        *)objects[oid])->timer);
                else run_timer(&((struct pwm_out_s *)objects[oid])->timer);
            }
            times[oid-1]=milliseconds()-start;
        }
        printf("[%f,%f,%f,%f]%s\n", times[0],times[1],times[2],times[3],
        run==12?"":",");
    }
    puts("]"); assert(allocated==freed);
    for (int i=0; i<256; i++) free(objects[i]);
    return 0;
}
int main(int argc, char **argv) {
    (void)argv;
    if (argc>1) return benchmark();
    command_config_digital_out((uint32_t[]){1,1,0,0,300});
    command_set_digital_out_pwm_cycle((uint32_t[]){1,100});
    command_config_pwm_out((uint32_t[]){2,2,100,0,0,300});
    struct digital_out_s *d=objects[1]; struct pwm_out_s *p=objects[2];
    // Legacy commands remain usable before opting in.
    command_queue_digital_out((uint32_t[]){1,100,50});
    command_queue_pwm_out((uint32_t[]){2,100,128});
    command_reset_digital_out_generation((uint32_t[]){1,1});
    command_reset_pwm_out_generation((uint32_t[]){2,1});
    assert(move_queue_empty(&d->mq) && move_queue_empty(&p->mq));
    assert(allocated==freed && !test_pins[1] && !test_pins[2]);
    for (int i=0; i<256; i++) assert(!timers[i]);
    // Timer events actually apply new power, then a reset clears toggling too.
    command_queue_digital_out_generation((uint32_t[]){1,200,25,1});
    command_queue_pwm_out_generation((uint32_t[]){2,200,128,1});
    run_timer(&d->timer); run_timer(&p->timer);
    assert(test_pins[1]==1 && test_pins[2]==128);
    command_reset_digital_out_generation((uint32_t[]){1,2});
    command_reset_pwm_out_generation((uint32_t[]){2,2});
    assert(!test_pins[1] && !test_pins[2]);
    for (int i=0; i<256; i++) assert(!timers[i]);
    int before=allocated;
    command_queue_digital_out_generation((uint32_t[]){1,300,100,1});
    command_queue_pwm_out_generation((uint32_t[]){2,300,255,1});
    assert(allocated==before && !test_pins[1] && !test_pins[2]);
    // Duplicate/stale resets must not erase new-generation work.
    command_queue_digital_out_generation((uint32_t[]){1,400,100,2});
    command_queue_pwm_out_generation((uint32_t[]){2,400,255,2});
    command_reset_digital_out_generation((uint32_t[]){1,2});
    command_reset_pwm_out_generation((uint32_t[]){2,1});
    assert(!move_queue_empty(&d->mq) && !move_queue_empty(&p->mq));
    FAILS(command_queue_digital_out((uint32_t[]){1,500,50}));
    FAILS(command_update_digital_out((uint32_t[]){1,1}));
    FAILS(command_set_digital_out_pwm_cycle((uint32_t[]){1,100}));
    FAILS(command_queue_pwm_out((uint32_t[]){2,500,128}));
    FAILS(command_queue_pwm_out_generation((uint32_t[]){2,500,128,3}));
    FAILS(command_queue_pwm_out_generation((uint32_t[]){2,500,128,0}));
    FAILS(command_queue_digital_out_generation((uint32_t[]){1,500,50,3}));
    FAILS(command_queue_digital_out_generation((uint32_t[]){1,500,50,0}));
    FAILS(command_reset_pwm_out_generation((uint32_t[]){2,4}));
    FAILS(command_reset_digital_out_generation((uint32_t[]){1,4}));
    command_reset_digital_out_generation((uint32_t[]){1,3});
    command_reset_pwm_out_generation((uint32_t[]){2,3});
    // Drain large queued batches without losing allocations or affecting peers.
    command_queue_pwm_out_generation((uint32_t[]){2,600,255,3});
    for (int i=0; i<512; i++)
        command_queue_digital_out_generation((uint32_t[]){1,600+(uint32_t)i,50,
        3});
    command_reset_digital_out_generation((uint32_t[]){1,4});
    assert(move_queue_empty(&d->mq) && !move_queue_empty(&p->mq));
    command_reset_pwm_out_generation((uint32_t[]){2,4});
        assert(allocated==freed);
    // Inverted outputs return to their configured safe electrical default.
    command_config_digital_out((uint32_t[]){3,3,1,1,300});
    command_set_digital_out_pwm_cycle((uint32_t[]){3,100});
    command_config_pwm_out((uint32_t[]){4,4,100,255,255,300});
    test_pins[3]=test_pins[4]=0;
    command_reset_digital_out_generation((uint32_t[]){3,1});
    command_reset_pwm_out_generation((uint32_t[]){4,1});
    assert(test_pins[3]==1 && test_pins[4]==255);
    d->generation=p->generation=UINT32_MAX-1;
    command_reset_digital_out_generation((uint32_t[]){1,UINT32_MAX});
    command_reset_pwm_out_generation((uint32_t[]){2,UINT32_MAX});
    FAILS(command_reset_pwm_out_generation((uint32_t[]){2,0}));
    FAILS(command_reset_digital_out_generation((uint32_t[]){1,0}));
    assert(allocated==freed && test_irq);
    for (int i=0; i<256; i++) free(objects[i]);
    puts("firmware output generations: passed");
    return 0;
}
