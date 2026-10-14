/* Standard LMDB read-only snapshot exporter. GPL-3.0-or-later.
 * fd 3 is an already pinned directory. MDB_RDONLY deliberately retains normal
 * LMDB reader-table locking; lock.mdb may change, data.mdb must not be written.
 * The trusted caller must arrange a quiescent source before migration. */
#define _GNU_SOURCE
#include "lmdb/lmdb.h"
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <stdarg.h>

static struct stat approved_data, approved_lock;
/* Linker wrapping constrains the stock library's actual open, before it can
 * map/write a reader table. The vendored LMDB bytes remain unmodified. */
int __wrap_open(const char *path, int flags, ...) {
    const char *name; const struct stat *approved; struct stat actual;
    if (strcmp(path, "/proc/self/fd/3/data.mdb") == 0) {
        name = "data.mdb"; approved = &approved_data;
        if ((flags & O_ACCMODE) != O_RDONLY) { errno = EACCES; return -1; }
    } else if (strcmp(path, "/proc/self/fd/3/lock.mdb") == 0) {
        name = "lock.mdb"; approved = &approved_lock;
        if ((flags & O_ACCMODE) != O_RDWR) { errno = EACCES; return -1; }
    } else { errno = EACCES; return -1; }
    int fd = openat(3, name, (flags & ~(O_CREAT | O_TRUNC)) | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return -1;
    if (fstat(fd, &actual) || !S_ISREG(actual.st_mode) || actual.st_nlink != 1
        || actual.st_dev != approved->st_dev || actual.st_ino != approved->st_ino) {
        close(fd); errno = ESTALE; return -1;
    }
    return fd;
}

static int put(const void *data, size_t length) {
    const unsigned char *p = data;
    while (length) {
        ssize_t written = write(STDOUT_FILENO, p, length);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return -1;
        p += written; length -= (size_t)written;
    }
    return 0;
}
static int number(uint64_t value) {
    unsigned char bytes[8];
    for (int i = 7; i >= 0; i--) { bytes[i] = (unsigned char)value; value >>= 8; }
    return put(bytes, sizeof(bytes));
}
static int regular(const char *name, struct stat *status) {
    return fstatat(3, name, status, AT_SYMLINK_NOFOLLOW) == 0
        && S_ISREG(status->st_mode) && status->st_nlink == 1;
}
int main(int argc, char **argv) {
    (void)argv;
    MDB_env *env = NULL; MDB_txn *txn = NULL; MDB_cursor *root = NULL, *cursor = NULL;
    MDB_dbi main_db, db; MDB_val ns, ignored, key, value;
    struct stat directory, before, opened, after, lock;
    int result = 1, rc = 0, fd; uint64_t records = 0, bytes = 0, namespaces = 0;
    if (argc != 1 || getuid() == 0 || geteuid() == 0 || getuid() != geteuid()
        || getgid() != getegid() || fstat(3, &directory) || !S_ISDIR(directory.st_mode)
        || !regular("data.mdb", &before) || before.st_size <= 0
        || before.st_size > 200 * 1024 * 1024 || !regular("lock.mdb", &lock)) goto done;
    approved_data = before; approved_lock = lock;
    if ((rc = mdb_env_create(&env)) || (rc = mdb_env_set_maxdbs(env, 100))
        || (rc = mdb_env_set_mapsize(env, 200 * 1024 * 1024))
        || (rc = mdb_env_open(env, "/proc/self/fd/3", MDB_RDONLY, 0))
        || (rc = mdb_env_get_fd(env, &fd)) || fstat(fd, &opened)
        || opened.st_dev != before.st_dev || opened.st_ino != before.st_ino
        || (rc = mdb_txn_begin(env, NULL, MDB_RDONLY, &txn))
        || (rc = mdb_dbi_open(txn, NULL, 0, &main_db))
        || (rc = mdb_cursor_open(txn, main_db, &root))) goto done;
    if (put("ANYLMDB1", 8) || number(mdb_txn_id(txn))) goto done;
    for (rc = mdb_cursor_get(root, &ns, &ignored, MDB_FIRST); rc == 0;
         rc = mdb_cursor_get(root, &ns, &ignored, MDB_NEXT)) {
        char name[1025];
        if (!ns.mv_size || ns.mv_size > 1024 || memchr(ns.mv_data, 0, ns.mv_size)
            || ++namespaces > 100) goto done;
        memcpy(name, ns.mv_data, ns.mv_size); name[ns.mv_size] = 0;
        if ((rc = mdb_dbi_open(txn, name, 0, &db))
            || (rc = mdb_cursor_open(txn, db, &cursor))) goto done;
        int next;
        for (next = mdb_cursor_get(cursor, &key, &value, MDB_FIRST); next == 0;
             next = mdb_cursor_get(cursor, &key, &value, MDB_NEXT)) {
            if (!key.mv_size || key.mv_size > 1024 || !value.mv_size
                || value.mv_size > 1024 * 1024 || ++records > 1000000) goto done;
            uint64_t size = 24 + ns.mv_size + key.mv_size + value.mv_size;
            if (size > 256 * 1024 * 1024 - bytes) goto done;
            bytes += size;
            if (number(ns.mv_size) || number(key.mv_size) || number(value.mv_size)
                || put(ns.mv_data, ns.mv_size) || put(key.mv_data, key.mv_size)
                || put(value.mv_data, value.mv_size)) goto done;
        }
        mdb_cursor_close(cursor); cursor = NULL;
        if (next != MDB_NOTFOUND) { rc = next; goto done; }
    }
    if (rc != MDB_NOTFOUND || !regular("data.mdb", &after)
        || after.st_dev != before.st_dev || after.st_ino != before.st_ino
        || after.st_size != before.st_size
        || after.st_mtim.tv_sec != before.st_mtim.tv_sec
        || after.st_mtim.tv_nsec != before.st_mtim.tv_nsec) goto done;
    /* A complete trailer is required in addition to successful child close. */
    if (number(0) || number(records) || number(namespaces)) goto done;
    result = 0;
done:
    if (cursor) mdb_cursor_close(cursor);
    if (root) mdb_cursor_close(root);
    if (txn) mdb_txn_abort(txn);
    if (env) mdb_env_close(env);
    if (result) fprintf(stderr, "LMDB snapshot rejected: %s\n", rc ? mdb_strerror(rc) : "identity, bounds or output failure");
    return result;
}
