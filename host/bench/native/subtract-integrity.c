/* Independent binary64 subtraction control; no printer or Node dependencies. */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>

static uint64_t
bits(double value)
{
    uint64_t result;
    memcpy(&result, &value, 8);
    return result;
}

int
main(int argc, char **argv)
{
    if (argc != 3 || sizeof(double) != 8)
        return 3;
    char *end;
    unsigned long rounds = strtoul(argv[2], &end, 10);
    if (*end || !rounds || rounds > 100000)
        return 3;
    FILE *file = fopen(argv[1], "rb");
    if (!file)
        return 3;
    if (fseek(file, 0, SEEK_END)) {
        fclose(file);
        return 3;
    }
    long size = ftell(file);
    rewind(file);
    if (size <= 0 || size % 16 || size > 1600000) {
        fclose(file);
        return 3;
    }
    double *data = malloc((size_t)size);
    if (!data) {
        fclose(file);
        return 3;
    }
    if (fread(data, 1, (size_t)size, file) != (size_t)size) {
        free(data);
        fclose(file);
        return 3;
    }
    fclose(file);
    volatile double *input = data;
    unsigned long count = (unsigned long)size / 16;
    for (unsigned long run = 0; run < rounds; run++) {
        for (unsigned long i = 0; i < count; i++) {
            double a = input[2*i], b = input[2*i+1];
            volatile double difference = a - b;
            double observed = difference;
            if (!isfinite(a) || !isfinite(b) || observed != 0.0) {
                printf("{\"run\":%lu,\"index\":%lu,\"a\":\"%016llx\","
                       "\"b\":\"%016llx\",\"difference\":\"%016llx\"}\n",
                       run, i, (unsigned long long)bits(a),
                       (unsigned long long)bits(b),
                       (unsigned long long)bits(observed));
                free(data);
                return 2;
            }
        }
    }
    printf("subtract:verified:%lu:%lu\n", rounds, count);
    free(data);
    return 0;
}
