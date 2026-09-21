// GPL-3.0-or-later. Test-only vcan <-> Node firmware byte stream bridge.
#include <linux/can.h>
#include <linux/can/raw.h>
#include <net/if.h>
#include <sys/socket.h>
#include <unistd.h>
#include <poll.h>
#include <stdio.h>
#include <assert.h>
#include <string.h>
static void output(const void *data, size_t length)
{
    const char *p=data;
    while (length) {
        ssize_t n=write(STDOUT_FILENO,p,length);
        assert(n > 0);
        p+=n;
        length-=n;
    }
}
int main(int argc, char **argv)
{
    const char *uuid=argc>1 ? argv[1] : "112233445566";
    assert(strlen(uuid)==12);
    unsigned char id[6];
    for (int i=0;i<6;i++) {
        unsigned value;
        assert(sscanf(uuid+2*i,"%2x",&value)==1);
        id[i]=(unsigned char)value;
    }
    int needs_reboot=argc>2 && !strcmp(argv[2],"reboot"),rebooted=0;
    int fd=socket(PF_CAN,SOCK_RAW|SOCK_CLOEXEC,CAN_RAW);
    assert(fd >= 0);
    struct can_filter filters[2]={
        {.can_id=0x202,.can_mask=CAN_SFF_MASK|CAN_EFF_FLAG|CAN_RTR_FLAG},
        {.can_id=0x3f0,.can_mask=CAN_SFF_MASK|CAN_EFF_FLAG|CAN_RTR_FLAG}
    };
    assert(!setsockopt(fd,SOL_CAN_RAW,CAN_RAW_FILTER,filters,sizeof(filters)));
    struct sockaddr_can address={.can_family=AF_CAN,
        .can_ifindex=(int)if_nametoindex("vcan-test")};
    assert(address.can_ifindex > 0);
    assert(!bind(fd,(struct sockaddr *)&address,sizeof(address)));
    fputs("READY\n",stderr);
    int assigned=0;
    for (;;) {
        struct pollfd p[2]={{.fd=fd,.events=POLLIN},
                           {.fd=STDIN_FILENO,.events=POLLIN}};
        assert(poll(p,2,10000) > 0);
        if (p[0].revents&POLLIN) {
            struct can_frame f;
            assert(read(fd,&f,sizeof(f)) == sizeof(f) && f.len <= 8);
            if (f.can_id == 0x3f0) {
                if (f.data[0]==2) {
                    assert(needs_reboot && !rebooted && !assigned);
                    assert(f.len==7 && !memcmp(f.data+1,id,6));
                    rebooted=1;
                    fputs("REBOOT\n",stderr);
                    continue;
                }
                assert(!needs_reboot || rebooted);
                unsigned char expected[8]={17};
                memcpy(expected+1,id,6);
                expected[7]=129;
                assert(!assigned && f.len == 8);
                assert(!memcmp(f.data,expected,8));
                assigned=1;
                fputs("ASSIGNED\n",stderr);
            } else {
                assert(assigned && f.can_id == 0x202);
                output(f.data,f.len);
            }
        }
        if (p[1].revents&(POLLIN|POLLHUP)) {
            unsigned char bytes[4096];
            ssize_t n=read(STDIN_FILENO,bytes,sizeof(bytes));
            if (!n) break;
            assert(n > 0);
            // No physical CAN wire or flash delay is modeled.
            for (ssize_t offset=0; offset<n; offset+=8) {
                struct can_frame f={.can_id=0x203};
                f.len=n-offset > 8 ? 8 : n-offset;
                memcpy(f.data,bytes+offset,f.len);
                assert(write(fd,&f,sizeof(f)) == sizeof(f));
            }
        }
    }
    close(fd);
    return 0;
}
