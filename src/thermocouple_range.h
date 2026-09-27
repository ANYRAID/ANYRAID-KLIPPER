#ifndef __THERMOCOUPLE_RANGE_H
#define __THERMOCOUPLE_RANGE_H
#include <stdint.h>

// Compare signed MAX31855 wire words without implementation-defined casts.
// XOR maps two's-complement order to unsigned order, preserving cold-junction
// bits inside each quarter-degree bucket.
static inline uint8_t
max31855_out_of_range(uint32_t value, uint32_t minimum, uint32_t maximum)
{
    uint32_t ordered = value ^ UINT32_C(0x80000000);
    return ordered < (minimum ^ UINT32_C(0x80000000))
        || ordered > (maximum ^ UINT32_C(0x80000000));
}

static inline uint8_t
max31855_fault(uint32_t value)
{
    // Preserve detailed fault bits; use bit 3 for an isolated summary fault
    // or reserved-bit corruption so the uint8 response cannot truncate it.
    return (value & 7) | ((value & UINT32_C(0x30008)) ? 8 : 0);
}
#endif
