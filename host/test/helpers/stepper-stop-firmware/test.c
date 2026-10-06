// Actual stepper/trsync firmware handlers; deterministic GPIO/timer stubs only.
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#define __SCHED_H
#define __COMMAND_H
#define DECL_COMMAND(func, format)
#define DECL_CONSTANT(name, value)
#define DECL_SHUTDOWN(func)
#define DECL_TASK(func)
#define likely(value) __builtin_expect(!!(value), 1)
#define unlikely(value) __builtin_expect(!!(value), 0)
#define DIV_ROUND_UP(value, divisor) (((value)+(divisor)-1u)/(divisor))
#define shutdown(message) do { fprintf(stderr, "%s\n", message); abort(); } \
        while (0)
struct timer { struct timer *next; uint_fast8_t (*func)(struct timer *);
        uint32_t waketime; };
struct task_wake { uint8_t wake; };
enum { SF_DONE=0, SF_RESCHEDULE=1 };
uint8_t test_irq=1;
uint32_t test_pins[256];
static struct timer *timers[256];
static uint32_t timer_from_us(uint32_t value) { return value; }
static void sched_add_timer(struct timer *timer) {
    for (int i=0; i<256; i++) if (!timers[i] || timers[i]==timer) {
        timers[i]=timer; return; }
    assert(0);
}
static void sched_del_timer(struct timer *timer) { for (int i=0; i<256; i++) if
        (timers[i]==timer) timers[i]=NULL; }
static void sched_wake_task(struct task_wake *wake) { wake->wake=1; }
static uint8_t sched_check_wake(struct task_wake *wake) { uint8_t result=
        wake->wake; wake->wake=0; return result; }
static void test_sendf(const char *format, ...) {}
#define sendf(format, ...) test_sendf(format, __VA_ARGS__)
#include "../../../../src/trsync.c"
#include "../../../../src/stepper.c"
static void *objects[256], *types[256];
static int allocated, freed;
void *oid_alloc(uint8_t oid, void *type, uint16_t size) { assert(!objects[oid]);
        types[oid]=type; return objects[oid]=calloc(1,size); }
void *oid_lookup(uint8_t oid, void *type) { assert(objects[oid] &&
        types[oid]==type); return objects[oid]; }
void *oid_next(uint8_t *i, void *type) {
    for (int n=(uint8_t)(*i+1); n<256; n++) if (types[n]==type) {
        *i=n; return objects[n]; }
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
static int32_t position(struct stepper *stepper) {
    return (int32_t)(stepper_get_position(stepper)-POSITION_BIAS);
}
static void complete(struct stepper *stepper) {
    for (int i=0; stepper->count; i++) {
        assert(i<1000);
        irqstatus_t flag=irq_save();
        if (stepper->time.func(&stepper->time)==SF_DONE)
            sched_del_timer(&stepper->time);
        irq_restore(flag);
    }
}
int main(void) {
    command_config_stepper((uint32_t[]){0,0,1,1,1});
    command_config_stepper((uint32_t[]){1,2,3,1,1});
    command_config_trsync((uint32_t[]){8});
    struct stepper *s=objects[0], *other=objects[1];
    s->position=other->position=-(POSITION_BIAS-24);
    assert(position(s)==-24 && position(other)==-24);
    command_reset_step_clock((uint32_t[]){0,2000000});
    command_trsync_start((uint32_t[]){8,2000000,1000,4});
    command_stepper_stop_on_trigger((uint32_t[]){0,8});
    // Future steps are queued, not executed when their frame is accepted.
    command_queue_step((uint32_t[]){0,1000,20,0});
    command_queue_step((uint32_t[]){0,1000,5,0});
    assert(position(s)==-24);
    command_trsync_trigger((uint32_t[]){8,1});
    assert(position(s)==-24 && s->count==0 && move_queue_empty(&s->mq));
    assert(s->flags & SF_NEED_RESET);
    int before=freed;
    // Exact discriminating late -20 command: real MCU discards it.
    command_queue_step((uint32_t[]){0,1000,20,0});
    assert(freed==before+1 && position(s)==-24 && s->count==0);
    // Trigger owns only its registered stepper; an unbound motor still moves.
    command_reset_step_clock((uint32_t[]){1,2000000});
    command_queue_step((uint32_t[]){1,1000,20,0}); complete(other);
    assert(position(other)==-44);
    command_reset_step_clock((uint32_t[]){0,2100000});
    command_set_next_step_dir((uint32_t[]){0,1});
    command_queue_step((uint32_t[]){0,1000,16,0}); complete(s);
    assert(position(s)==-8);
    // Duplicate old trigger cannot stop motion after explicit reinitialization.
    command_queue_step((uint32_t[]){0,1000,2,0});
    command_trsync_trigger((uint32_t[]){8,1}); complete(s);
    assert(position(s)==-6);
    assert(allocated==freed);
    puts("{\"afterStop\":-24,\"afterLate\":-24,\"unboundAfterLate\":-44,"
         "\"afterReset\":-8,\"afterDuplicate\":-6}");
    for (int i=0; i<256; i++) free(objects[i]);
    return 0;
}
