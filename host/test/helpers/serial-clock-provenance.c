#include <assert.h>
#include <sys/socket.h>
#include <time.h>
#include "pyhelper.h"
static double sampled_now(void);
#define get_monotonic sampled_now
#include SERIALQUEUE_SOURCE
#undef get_monotonic

static struct serialqueue *injected_sq;
static struct command_queue *injected_cq;
static double requested;
static uint8_t payload[] = {3};

static double
sampled_now(void)
{
    double sampled = get_monotonic();
    if (injected_sq) {
        struct serialqueue *sq = injected_sq;
        injected_sq = NULL;
        // Reproduce a producer enqueue after the consumer's clock sample but
        // before it acquires transmit_requests.lock and moves upcoming bytes.
        struct timespec pause = {.tv_nsec = 1000000};
        nanosleep(&pause, NULL);
        requested = get_monotonic();
        serialqueue_send(sq, injected_cq, payload, sizeof(payload), 0, 0, 1);
    }
    return sampled;
}

static int
check(int inject)
{
    int fd[2];
    assert(!socketpair(AF_UNIX, SOCK_STREAM, 0, fd));
    char name[16] = "clock-test";
    struct serialqueue *sq = serialqueue_alloc(fd[0], 'u', 0, name);
    assert(sq);
    serialqueue_exit(sq);
    struct command_queue *cq = serialqueue_alloc_commandqueue();
    requested = get_monotonic();
    if (inject) {
        injected_sq = sq;
        injected_cq = cq;
    } else {
        serialqueue_send(sq, cq, payload, sizeof(payload), 0, 0, 1);
    }
    command_event(sq, requested - 1.);
    assert(!list_empty(&sq->sent_queue));
    struct queue_message *sent = list_first_entry(
        &sq->sent_queue, struct queue_message, node);
    int good = sent->sent_time >= requested && sent->receive_time >= requested;
    serialqueue_free(sq);
    serialqueue_free_commandqueue(cq);
    close(fd[0]);
    close(fd[1]);
    return good;
}
int main(void)
{
    return check(0) && check(1) ? 0 : 2;
}
