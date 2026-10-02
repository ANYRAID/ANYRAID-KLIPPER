#ifndef TEST_MISC_H
#define TEST_MISC_H
#include <stdint.h>
#include <stddef.h>
#define container_of(ptr, type, member) ((type *)((char *)(ptr) - \
        offsetof(type, member)))
static inline int timer_is_before(uint32_t a, uint32_t b) { return
        (int32_t)(a-b) < 0; }
static inline uint32_t timer_read_time(void) { return 0; }
#endif
