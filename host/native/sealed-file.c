#define _GNU_SOURCE
#include <node_api.h>
#include <sys/mman.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

static napi_value
failure(napi_env env, const char *operation)
{
    char text[256];
    snprintf(text, sizeof(text), "%s: %s", operation, strerror(errno));
    napi_throw_error(env, NULL, text);
    return NULL;
}

static napi_value
create(napi_env env, napi_callback_info info)
{
    (void)info;
    int fd = memfd_create("anyraid-print", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (fd < 0)
        return failure(env, "Create sealed print file");
    napi_value result;
    if (napi_create_int32(env, fd, &result) != napi_ok) {
        close(fd);
        napi_throw_error(env, NULL, "Return sealed file descriptor");
        return NULL;
    }
    return result;
}

static napi_value
seal(napi_env env, napi_callback_info info)
{
    size_t count = 1;
    napi_value args[1];
    double number;
    if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok
        || count != 1
        || napi_get_value_double(env, args[0], &number) != napi_ok
        || !isfinite(number) || number < 0 || number > INT_MAX
        || floor(number) != number) {
        napi_throw_type_error(env, NULL, "Invalid sealed file descriptor");
        return NULL;
    }
    int fd = (int)number;
    int required = F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL;
    int actual = fcntl(fd, F_GET_SEALS);
    if (actual < 0)
        return failure(env, "Read print file seals");
    if ((actual & required) != required
        && fcntl(fd, F_ADD_SEALS, required) < 0)
        return failure(env, "Seal print file");
    actual = fcntl(fd, F_GET_SEALS);
    if (actual < 0)
        return failure(env, "Verify print file seals");
    if ((actual & required) != required) {
        napi_throw_error(env, NULL, "Incomplete print file seals");
        return NULL;
    }
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}

static napi_value
lock_directory(napi_env env, napi_callback_info info)
{
    size_t count = 1;
    napi_value args[1];
    double number;
    if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok
        || count != 1
        || napi_get_value_double(env, args[0], &number) != napi_ok
        || !isfinite(number) || number < 0 || number > INT_MAX
        || floor(number) != number) {
        napi_throw_type_error(env, NULL, "Invalid directory descriptor");
        return NULL;
    }
    int fd = (int)number;
    struct stat status;
    if (fstat(fd, &status) < 0)
        return failure(env, "Read directory for locking");
    if (!S_ISDIR(status.st_mode)) {
        napi_throw_type_error(env, NULL, "Storage lock requires directory");
        return NULL;
    }
    if (flock(fd, LOCK_EX | LOCK_NB) < 0)
        return failure(env, "Lock published file directory");
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}

static napi_value
page_size(napi_env env, napi_callback_info info)
{
    (void)info;
    long size = sysconf(_SC_PAGESIZE);
    if (size <= 0 || size > INT_MAX) {
        napi_throw_error(env, NULL, "Invalid kernel page size");
        return NULL;
    }
    napi_value result;
    if (napi_create_int32(env, (int)size, &result) != napi_ok) {
        napi_throw_error(env, NULL, "Return kernel page size");
        return NULL;
    }
    return result;
}

static napi_value
init(napi_env env, napi_value exports)
{
    napi_property_descriptor methods[] = {
        {"create", NULL, create, NULL, NULL, NULL, napi_default, NULL},
        {"seal", NULL, seal, NULL, NULL, NULL, napi_default, NULL},
        {"pageSize", NULL, page_size, NULL, NULL, NULL, napi_default, NULL},
        {"lockDirectory", NULL, lock_directory, NULL, NULL, NULL,
         napi_default, NULL}
    };
    if (napi_define_properties(env, exports, 4, methods) != napi_ok) {
        napi_throw_error(env, NULL, "Register sealed file methods");
        return NULL;
    }
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
