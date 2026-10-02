#include <inttypes.h>
#include STEP_SOURCE
int main(int argc, char **argv)
{
    if (argc != 2)
        return 1;
    int rows = atoi(argv[1]);
    if (rows < 1 || rows > 65536)
        return 1;
    struct list_head messages;
    list_init(&messages);
    struct stepcompress *sc = stepcompress_alloc(&messages);
    uint64_t first = (1ULL << 54), *starts = calloc(rows, sizeof(*starts));
    int64_t pos = 0;
    for (int i = 0; i < rows; i++) {
        struct history_steps *h = calloc(1, sizeof(*h));
        h->first_clock = starts[i] = first;
        h->start_position = pos;
        h->step_count = i % 2 ? -64 : 64;
        h->interval = 1000;
        h->add = i % 2 ? -2 : 2;
        h->last_clock = first + 63000 + h->add * 2016;
        pos += h->step_count;
        first = h->last_clock + 100;
        list_add_head(&h->node, &sc->history_list);
    }
    sc->last_position = pos;
    int64_t sum = 0;
    double start = get_monotonic();
    for (int i = 0; i < 10000; i++) {
        int row = (i * 7919) % rows, k = i % 64 + 1;
        int add = row % 2 ? -2 : 2;
        uint64_t at = starts[row] + (k-1)*1000 + add*k*(k-1)/2;
        sum += stepcompress_find_past_position(sc, at);
    }
    printf("{\"ms\":%.9f,\"sum\":%" PRId64 "}\n",
           (get_monotonic()-start)*1000., sum);
    stepcompress_free(sc);
    free(starts);
    return 0;
}
