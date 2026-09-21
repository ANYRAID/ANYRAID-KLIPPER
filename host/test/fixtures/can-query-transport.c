// Test-only syscall substitutes. Compile the actual Node-API implementation.
#include <node_api.h>
#include <linux/can.h>
#include <linux/can/raw.h>
#include <net/if.h>
#include <sys/socket.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <assert.h>
static char mode[32];
static int opened, closed, sends, reads, filters, binds;
static unsigned mock_index(const char *name)
{
    assert(!strcmp(name, "mock0"));
    return 7;
}
static int mock_socket(int family, int type, int protocol)
{
    assert(family == PF_CAN);
    assert(type == (SOCK_RAW | SOCK_NONBLOCK | SOCK_CLOEXEC));
    assert(protocol == CAN_RAW);
    if (!strcmp(mode, "socket")) { errno = EMFILE; return -1; }
    opened++;
    return 123;
}
static int mock_filter(int fd, int level, int option,
                       const void *value, socklen_t length)
{
    assert(fd == 123 && level == SOL_CAN_RAW && option == CAN_RAW_FILTER);
    assert(length == sizeof(struct can_filter));
    const struct can_filter *f = value;
    assert(f->can_id == 0x3f1);
    assert(f->can_mask == (CAN_SFF_MASK | CAN_EFF_FLAG
                          | CAN_RTR_FLAG | CAN_ERR_FLAG));
    filters++;
    if (!strcmp(mode, "filter")) { errno = EINVAL; return -1; }
    return 0;
}
static int mock_bind(int fd, const struct sockaddr *addr, socklen_t length)
{
    assert(fd == 123 && length == sizeof(struct sockaddr_can));
    const struct sockaddr_can *a = (const struct sockaddr_can *)addr;
    assert(a->can_family == AF_CAN && a->can_ifindex == 7);
    binds++;
    if (!strcmp(mode, "bind")) { errno = ENODEV; return -1; }
    return 0;
}
static ssize_t mock_send(int fd, const void *data, size_t length, int flags)
{
    assert(fd == 123 && length == sizeof(struct can_frame));
    assert(flags == MSG_NOSIGNAL);
    const struct can_frame *f = data;
    assert(f->can_id == 0x3f0 && f->len == 1);
    for (unsigned i = 0; i < sizeof(f->data); i++)
        assert(f->data[i] == 0);
    sends++;
    if (!strcmp(mode, "eintr") && sends == 1) {
        errno = EINTR;
        return -1;
    }
    if (!strcmp(mode, "send")) { errno = ENOBUFS; return -1; }
    return !strcmp(mode, "shortsend") ? (ssize_t)length-1 : (ssize_t)length;
}
static ssize_t mock_recv(int fd, void *data, size_t length, int flags)
{
    assert(fd == 123 && length == sizeof(struct can_frame));
    assert(flags == (MSG_DONTWAIT | MSG_TRUNC));
    reads++;
    if (!strcmp(mode, "eintr") && reads == 1) {
        errno = EINTR;
        return -1;
    }
    if (!strcmp(mode, "read")) { errno = ENETDOWN; return -1; }
    if (reads > (!strcmp(mode, "eintr") ? 2 : 1)) {
        errno = EAGAIN;
        return -1;
    }
    struct can_frame f = {
        .can_id = 0x3f1, .len = 8,
        .data = {0x20, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x11}
    };
    if (!strcmp(mode, "badlen")) f.len = 9;
    memcpy(data, &f, sizeof(f));
    if (!strcmp(mode, "shortread")) return length-1;
    if (!strcmp(mode, "oversizeread")) return CANFD_MTU;
    return length;
}
static int mock_close(int fd)
{
    assert(fd == 123 && closed < opened);
    closed++;
    return 0;
}
#define if_nametoindex mock_index
#define socket mock_socket
#define setsockopt mock_filter
#define bind mock_bind
#define send mock_send
#define recv mock_recv
#define close mock_close
#undef NAPI_MODULE
#define NAPI_MODULE(modname,regfunc)
#include "../../native/can-query.c"
#undef close
static napi_value configure(napi_env env, napi_callback_info info)
{
    size_t n = 1, length;
    napi_value a, result;
    assert(opened == closed);
    assert(napi_get_cb_info(env, info, &n, &a, NULL, NULL) == napi_ok);
    assert(n == 1);
    assert(napi_get_value_string_utf8(env, a, mode, sizeof(mode), &length)
           == napi_ok && length < sizeof(mode));
    opened = closed = sends = reads = filters = binds = 0;
    napi_get_undefined(env, &result);
    return result;
}
static napi_value stats(napi_env env, napi_callback_info info)
{
    (void)info;
    napi_value result, v;
    napi_create_object(env, &result);
    const char *names[] = {
        "opened", "closed", "sends", "reads", "filters", "binds"
    };
    int values[] = {opened, closed, sends, reads, filters, binds};
    for (int i = 0; i < 6; i++) {
        napi_create_int32(env, values[i], &v);
        napi_set_named_property(env, result, names[i], v);
    }
    return result;
}
NAPI_MODULE_INIT()
{
    init(env, exports);
    napi_property_descriptor d[] = {
        {"configure", NULL, configure, NULL, NULL, NULL, napi_default, NULL},
        {"stats", NULL, stats, NULL, NULL, NULL, napi_default, NULL}
    };
    napi_define_properties(env, exports, 2, d);
    return exports;
}
