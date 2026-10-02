// GPL-3.0-or-later. Bound SocketCAN descriptor with optional one-shot node assignment.
#include <node_api.h>
#include <linux/can.h>
#include <linux/can/raw.h>
#include <net/if.h>
#include <sys/socket.h>
#include <unistd.h>
#include <errno.h>
#include <math.h>
#include <string.h>
#include <stdio.h>
static napi_value can_fail(napi_env env, const char *operation)
{
    char text[256];
    snprintf(text, sizeof(text), "%s: %s", operation, strerror(errno));
    napi_throw_error(env, NULL, text);
    return NULL;
}
static napi_value open_can(napi_env env, napi_callback_info info)
{
    size_t count=3, length=0, uuid_length=0;
    void *uuid=NULL;
    napi_value args[3], result;
    char name[IFNAMSIZ];
    double client;
    if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok
        || (count != 2 && count != 3)
        || napi_get_value_string_utf8(env, args[0], NULL, 0, &length)
           != napi_ok || length == 0 || length >= sizeof(name)
        || napi_get_value_string_utf8(env, args[0], name, sizeof(name),
                                      &length) != napi_ok
        || strlen(name) != length
        || napi_get_value_double(env, args[1], &client) != napi_ok
        || !isfinite(client) || client < 256 || client > 766
        || floor(client/2) != client/2) {
        napi_throw_type_error(env, NULL, "Invalid CAN interface or client ID");
        return NULL;
    }
    if (count == 3
        && (napi_get_buffer_info(env, args[2], &uuid, &uuid_length) != napi_ok
            || uuid_length != 6)) {
        napi_throw_type_error(env, NULL, "CAN UUID must contain six bytes");
        return NULL;
    }
    unsigned index=if_nametoindex(name);
    if (!index) return can_fail(env, "Find CAN interface");
    int fd=socket(PF_CAN, SOCK_RAW|SOCK_NONBLOCK|SOCK_CLOEXEC, CAN_RAW);
    if (fd < 0) return can_fail(env, "Open CAN transport");
    struct can_filter filter={
        .can_id=(canid_t)client+1,
        .can_mask=CAN_SFF_MASK|CAN_EFF_FLAG|CAN_RTR_FLAG
    };
    const char *operation="Filter CAN transport";
    if (setsockopt(fd, SOL_CAN_RAW, CAN_RAW_FILTER, &filter, sizeof(filter)))
        goto error;
    struct sockaddr_can address={
        .can_family=AF_CAN, .can_ifindex=(int)index
    };
    operation="Bind CAN transport";
    if (bind(fd, (struct sockaddr *)&address, sizeof(address))) goto error;
    if (count == 3) {
        struct can_frame frame={.can_id=0x3f0, .len=8, .data={1}};
        memcpy(frame.data+1, uuid, 6);
        frame.data[7]=(unsigned char)((client-256)/2);
        operation="Assign CAN node";
        ssize_t written;
        do {
            written=send(fd, &frame, sizeof(frame), MSG_NOSIGNAL);
        } while (written < 0 && errno == EINTR);
        if (written < 0) goto error;
        if (written != sizeof(frame)) { errno=EIO; goto error; }
    }
    if (napi_create_int32(env, fd, &result) != napi_ok) {
        close(fd);
        napi_throw_error(env, NULL, "Return CAN descriptor");
        return NULL;
    }
    return result;
error:;
    int saved=errno;
    close(fd);
    errno=saved;
    return can_fail(env, operation);
}
napi_status can_transport_exports(napi_env env, napi_value exports)
{
    napi_property_descriptor d={
        "openCAN", NULL, open_can, NULL, NULL, NULL, napi_default, NULL
    };
    return napi_define_properties(env, exports, 1, &d);
}
