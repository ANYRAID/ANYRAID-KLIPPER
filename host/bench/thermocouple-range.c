// Host benchmark only; does not measure target MCU timing.
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <time.h>
#include "../../src/thermocouple_range.h"
static uint32_t samples[4096];
static volatile uint32_t checksum;
static volatile uint32_t lower = 0, upper = 38400 * 32 + 31;
static double now_ms(void)
{
    struct timespec time;
    clock_gettime(CLOCK_MONOTONIC, &time);
    return time.tv_sec * 1000. + time.tv_nsec / 1.e6;
}
static double measure(int signed_range)
{
    uint32_t count = 0;
    uint32_t minimum = lower, maximum = upper;
    double start = now_ms();
    for (int repeat = 0; repeat < 256; repeat++) {
        for (int i = 0; i < 4096; i++) {
            uint32_t value = samples[i];
            count += signed_range
                ? max31856_out_of_range(value, minimum, maximum)
                : value < minimum || value > maximum;
        }
    }
    checksum = count;
    return now_ms() - start;
}
int main(void)
{
    for (int i = 0; i < 4096; i++)
        samples[i] = (uint32_t)((i * 127) & 0x3ffff) * 32 + (i & 31);
    puts("{\"checksPerRun\":1048576,\"warmups\":4,\"samples\":[");
    for (int run = 0; run < 24; run++) {
        double first = measure(run & 1);
        uint32_t expected = checksum;
        double second = measure(!(run & 1));
        assert(checksum == expected);
        if (run >= 4)
            printf("%s{\"unsignedMs\":%.6f,\"signed24Ms\":%.6f}",
                   run == 4 ? "" : ",\n",
                   run & 1 ? second : first, run & 1 ? first : second);
    }
    printf("\n],\"checksum\":%u}\n", checksum);
    return 0;
}
