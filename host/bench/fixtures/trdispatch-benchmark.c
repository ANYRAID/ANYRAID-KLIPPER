// Isolated callback cost; queue I/O is replaced by a checksum sink.
#include <stdio.h>
#include <inttypes.h>
#include "serialqueue.h"
#include "pyhelper.h"
struct serialqueue { struct clock_estimate ce; };
struct command_queue { int unused; };
static uint64_t checksum, sent;
void serialqueue_get_clock_est(struct serialqueue *q, struct clock_estimate *ce)
{ *ce = q->ce; }
void serialqueue_add_fastreader(struct serialqueue *q, struct fastreader *f)
{ (void)q; (void)f; }
void serialqueue_rm_fastreader(struct serialqueue *q, struct fastreader *f)
{ (void)q; (void)f; }
#include TRDISPATCH_SOURCE
void serialqueue_send_one(struct serialqueue *q, struct command_queue *cq,
                          struct queue_message *m)
{
    (void)q; (void)cq;
    for (int i = 0; i < m->len; i++)
        checksum = checksum * 33 + m->msg[i];
    checksum = checksum * 33 + m->req_clock;
    sent++;
    free(m);
}
int main(int argc, char **argv)
{
    if (argc != 2)
        return 1;
    int count = atoi(argv[1]);
    if (count < 1 || count > 16)
        return 1;
    enum { REPORTS = 100000 };
    uint64_t base = (1ULL << 32) - 1000000;
    struct { uint8_t bytes[64]; int len; } *reports;
    reports = calloc(REPORTS, sizeof(*reports));
    for (int i = 0; i < REPORTS; i++) {
        uint32_t data[5] = {7, 8, 1, 0, base + (i+1)*1000};
        struct queue_message *m = message_alloc_and_encode(data, 5);
        memcpy(reports[i].bytes + 2, m->msg, m->len);
        reports[i].len = m->len + MESSAGE_MIN;
        free(m);
    }
    struct trdispatch *td = trdispatch_alloc();
    struct serialqueue queues[16];
    struct command_queue cq = {0};
    struct trdispatch_mcu *mcus[16];
    for (int i = 0; i < count; i++) {
        clock_fill(&queues[i].ce, 1000000., 0., base);
        mcus[i] = trdispatch_mcu_alloc(td, &queues[i], &cq, 8, 4, 5, 7);
        trdispatch_mcu_setup(mcus[i], base, base+25000, 25000, 6000);
    }
    trdispatch_start(td, 2);
    double start = get_monotonic();
    for (int i = 0; i < REPORTS; i++)
        handle_trsync_state(&mcus[i%count]->fr, (i+1)*.001,
                            reports[i].bytes, reports[i].len);
    double elapsed = get_monotonic() - start;
    printf("{\"ms\":%.9f,\"sent\":%" PRIu64 ",\"hash\":\"%" PRIu64 "\"}\n",
           elapsed * 1000., sent, checksum);
    trdispatch_free(td);
    free(reports);
    return 0;
}
