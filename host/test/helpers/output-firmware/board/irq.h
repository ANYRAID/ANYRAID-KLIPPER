#ifndef TEST_IRQ_H
#define TEST_IRQ_H
#include <stdint.h>
typedef uint8_t irqstatus_t;
extern uint8_t test_irq;
static inline void irq_disable(void) { test_irq = 0; }
static inline void irq_enable(void) { test_irq = 1; }
static inline irqstatus_t irq_save(void) { uint8_t old = test_irq; test_irq = 0;
        return old; }
static inline void irq_restore(irqstatus_t old) { test_irq = old; }
#endif
