// GPL-3.0-or-later. vcan-only integration peer, never used in production.
#include <linux/can.h>
#include <linux/can/raw.h>
#include <net/if.h>
#include <sys/socket.h>
#include <unistd.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
static void require(int ok, const char *message)
{
    if (!ok) { perror(message); exit(1); }
}
int main(int argc, char **argv)
{
    unsigned index = if_nametoindex("vcan-test");
    require(index != 0, "vcan-test index");
    int fd = socket(PF_CAN, SOCK_RAW | SOCK_CLOEXEC, CAN_RAW);
    require(fd >= 0, "socket");
    struct can_filter filter = {
        .can_id = 0x3f0,
        .can_mask = CAN_SFF_MASK | CAN_EFF_FLAG | CAN_RTR_FLAG
    };
    require(!setsockopt(fd, SOL_CAN_RAW, CAN_RAW_FILTER,
                       &filter, sizeof(filter)), "filter");
    struct sockaddr_can addr = {
        .can_family = AF_CAN, .can_ifindex = (int)index
    };
    require(!bind(fd, (struct sockaddr *)&addr, sizeof(addr)), "bind");
    puts("READY");
    fflush(stdout);
    struct pollfd pending = {.fd = fd, .events = POLLIN};
    if (argc > 1 && !strcmp(argv[1], "idle")) {
        require(poll(&pending, 1, 1000) == 0, "no packets before preflight");
        close(fd);
        return 0;
    }
    require(poll(&pending, 1, 5000) == 1, "query timeout");
    struct can_frame query;
    require(read(fd, &query, sizeof(query)) == sizeof(query), "query read");
    if (argc > 1) {
        require(query.can_id == 0x3f0 && query.len == 1
                && query.data[0] == 0x12, "reset content");
        puts("RESET");
        fflush(stdout);
        if (!strcmp(argv[1], "cancel")) {
            require(poll(&pending, 1, 1000) == 0, "no query after cancel");
            close(fd);
            return 0;
        }
        struct timespec start, end;
        require(!clock_gettime(CLOCK_MONOTONIC, &start), "reset time");
        require(poll(&pending, 1, 5000) == 1, "query after reset timeout");
        require(!clock_gettime(CLOCK_MONOTONIC, &end), "query time");
        require((end.tv_sec-start.tv_sec)*1000.
                + (end.tv_nsec-start.tv_nsec)/1000000. >= 450.,
                "reset settle interval");
        require(read(fd, &query, sizeof(query)) == sizeof(query), "query read");
    }
    require(query.can_id == 0x3f0 && query.len == 1 && query.data[0] == 0,
            "query content");
    struct can_frame replies[] = {
        {.can_id=0x3f1, .len=7, .data={32,0,0,0,0,0,0}},
        {.can_id=0x3f1, .len=8, .data={32,255,255,255,255,255,255,17}},
        {.can_id=0x3f1, .len=8, .data={32,17,170,34,187,51,204,99}},
        {.can_id=0x3f1, .len=8, .data={32,255,255,255,255,255,255,1}},
        {.can_id=0x3f2, .len=7, .data={32,1,2,3,4,5,6}},
        {.can_id=CAN_EFF_FLAG|0x3f1, .len=7, .data={32,1,2,3,4,5,6}},
        {.can_id=CAN_RTR_FLAG|0x3f1, .len=7, .data={32,1,2,3,4,5,6}},
        {.can_id=0x3f1, .len=2, .data={32,1}},
        {.can_id=0x3f1, .len=7, .data={33,1,2,3,4,5,6}}
    };
    for (unsigned i = 0; i < sizeof(replies)/sizeof(replies[0]); i++)
        require(write(fd, &replies[i], sizeof(replies[i]))
                == sizeof(replies[i]), "response write");
    close(fd);
    return 0;
}
