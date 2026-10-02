// GPL-3.0-or-later. Fixed-ID vcan peer for serialqueue framing tests.
#include <linux/can.h>
#include <linux/can/raw.h>
#include <net/if.h>
#include <sys/socket.h>
#include <unistd.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
static size_t hex(const char *text, unsigned char *bytes)
{
    size_t count=strlen(text)/2;
    assert(strlen(text)%2 == 0 && count <= 64);
    for (size_t i=0; i<count; i++) {
        unsigned v;
        assert(sscanf(text+2*i, "%2x", &v) == 1);
        bytes[i]=v;
    }
    return count;
}
int main(int argc, char **argv)
{
    assert(argc == 3);
    unsigned char expected[64], reply[64], got[64];
    size_t expected_size=hex(argv[1],expected), reply_size=hex(argv[2],reply);
    int fd=socket(PF_CAN,SOCK_RAW|SOCK_CLOEXEC,CAN_RAW);
    assert(fd >= 0);
    struct can_filter filter={.can_id=0x180,
        .can_mask=CAN_SFF_MASK|CAN_EFF_FLAG|CAN_RTR_FLAG};
    assert(!setsockopt(fd,SOL_CAN_RAW,CAN_RAW_FILTER,&filter,sizeof(filter)));
    struct sockaddr_can address={.can_family=AF_CAN,
        .can_ifindex=(int)if_nametoindex("vcan-test")};
    assert(address.can_ifindex > 0);
    assert(!bind(fd,(struct sockaddr *)&address,sizeof(address)));
    puts("READY");
    fflush(stdout);
    size_t received=0;
    while (received < expected_size) {
        struct pollfd p={.fd=fd,.events=POLLIN};
        assert(poll(&p,1,5000) == 1);
        struct can_frame f;
        assert(read(fd,&f,sizeof(f)) == sizeof(f));
        assert(f.can_id == 0x180 && f.len > 0 && f.len <= 8);
        assert(received+f.len <= expected_size);
        memcpy(got+received,f.data,f.len);
        received+=f.len;
    }
    assert(!memcmp(expected,got,expected_size));
    // vcan has no physical bit time; allow the configured 1 Mbit/s model.
    usleep(3000);
    for (size_t offset=0; offset<reply_size; offset+=8) {
        struct can_frame f={.can_id=0x181};
        f.len=reply_size-offset > 8 ? 8 : reply_size-offset;
        memcpy(f.data,reply+offset,f.len);
        assert(write(fd,&f,sizeof(f)) == sizeof(f));
    }
    close(fd);
    return 0;
}
