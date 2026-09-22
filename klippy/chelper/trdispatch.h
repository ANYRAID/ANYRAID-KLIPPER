#ifndef TRDISPATCH_H
#define TRDISPATCH_H
#include <stdint.h>
struct trdispatch;
struct trdispatch_mcu;
struct serialqueue;
struct command_queue;
struct trdispatch *trdispatch_alloc(void);
void trdispatch_start(struct trdispatch *, uint32_t);
void trdispatch_stop(struct trdispatch *);
void trdispatch_free(struct trdispatch *);
struct trdispatch_mcu *trdispatch_mcu_alloc(
    struct trdispatch *, struct serialqueue *, struct command_queue *,
    uint32_t, uint32_t, uint32_t, uint32_t);
void trdispatch_mcu_setup(struct trdispatch_mcu *, uint64_t, uint64_t,
                         uint64_t, uint64_t);
#endif
