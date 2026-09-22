#include <assert.h>
#include <sys/socket.h>
#include SERIALQUEUE_SOURCE
int main(void)
{
    int fd[2];
    assert(!socketpair(AF_UNIX, SOCK_STREAM, 0, fd));
    char name[16] = "clock-test";
    struct serialqueue *sq = serialqueue_alloc(fd[0], 'u', 0, name);
    assert(sq);
    // Stop the reactor so the test can deterministically pass an old eventtime
    // to its callback after a new request has entered the queue.
    serialqueue_exit(sq);
    struct command_queue *cq = serialqueue_alloc_commandqueue();
    uint8_t payload[] = {3};
    double requested = get_monotonic();
    serialqueue_send(sq, cq, payload, sizeof(payload), 0, 0, 1);
    command_event(sq, requested - 1.);
    assert(!list_empty(&sq->sent_queue));
    struct queue_message *sent = list_first_entry(
        &sq->sent_queue, struct queue_message, node);
    int good = sent->sent_time >= requested && sent->receive_time >= requested;
    serialqueue_free(sq);
    serialqueue_free_commandqueue(cq);
    close(fd[0]);
    close(fd[1]);
    return good ? 0 : 2;
}
