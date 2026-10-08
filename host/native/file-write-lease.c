// Private child process read lease. GPL-3.0-or-later, ANYRAID 2026.
#define _GNU_SOURCE
#include <sys/stat.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
static volatile sig_atomic_t broken;
static void break_lease(int signal) { (void)signal; broken = 1; }
int main(void) {
    // Reopen to own an independent open file description. Parent's borrowed
    // descriptor is never given a lease or signal ownership by this helper.
    int fd = open("/proc/self/fd/3", O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    struct stat source, leased;
    if (fd < 0 || fstat(3, &source) || fstat(fd, &leased)
        || !S_ISREG(leased.st_mode) || source.st_dev != leased.st_dev
        || source.st_ino != leased.st_ino) return 3;
    struct sigaction action = {.sa_handler = break_lease};
    sigset_t blocked, waiting;
    sigemptyset(&blocked);
    sigaddset(&blocked, SIGIO);
    sigemptyset(&action.sa_mask);
    // Block before admission, then atomically unblock only while waiting.
    // A break between testing 'broken' and sleeping must not strand a writer.
    if (sigprocmask(SIG_BLOCK, &blocked, &waiting)
        || sigaction(SIGIO, &action, NULL) || fcntl(fd, F_SETOWN, getpid()))
        return 3;
    sigdelset(&waiting, SIGIO);
    if (fcntl(fd, F_SETLEASE, F_RDLCK)) {
        int saved = errno;
        close(fd);
        if (saved == EAGAIN) { puts("busy"); return 2; }
        fprintf(stderr, "read lease unavailable: errno=%d\n", saved);
        return 3;
    }
    puts("ready"); fflush(stdout);
    int result = 0;
    struct pollfd input = {.fd = STDIN_FILENO, .events = POLLIN};
    while (!broken) {
        int count = ppoll(&input, 1, NULL, &waiting);
        if (count < 0) { if (errno == EINTR) continue; result = 3; break; }
        if (input.revents & (POLLHUP | POLLERR | POLLNVAL)) break;
        char command;
        if (read(STDIN_FILENO, &command, 1) != 1 || command == 'R') break;
        if (command != 'C') { result = 3; break; }
        if (fcntl(fd, F_GETLEASE) != F_RDLCK) { broken = 1; break; }
        puts("held"); fflush(stdout);
    }
    if (broken) result = 2;
    if (fcntl(fd, F_SETLEASE, F_UNLCK)) result = 3;
    close(fd);
    if (result == 2) { puts("broken"); fflush(stdout); }
    return result;
}
