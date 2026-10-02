// GPL-3.0-or-later. Linux 1200-baud/DTR bootloader entry.
// Caller must provide the standard ioctl/open/flock/close declarations.
static int usb_bootloader_touch(const char *path,const char **operation){
 *operation="Open USB bootloader port";
 int fd=open(path,O_RDONLY|O_NOCTTY|O_NONBLOCK|O_CLOEXEC);
 if(fd<0)return -1;
 *operation="Lock USB bootloader port";
 if(flock(fd,LOCK_EX|LOCK_NB))goto error;
 int bits=TIOCM_DTR;
 *operation="Raise USB bootloader DTR";
 if(ioctl(fd,TIOCMBIS,&bits))goto error;
 struct termios2 t;
 *operation="Read USB bootloader termios";
 if(ioctl(fd,TCGETS2,&t))goto error;
 t.c_cflag=(t.c_cflag&~(CBAUD|CIBAUD))|B1200;
 t.c_ispeed=t.c_ospeed=1200;
 *operation="Set USB bootloader 1200 baud";
 if(ioctl(fd,TCSETS2,&t))goto error;
 *operation="Lower USB bootloader DTR";
 if(ioctl(fd,TIOCMBIC,&bits))goto error;
 // Do not retry close: Linux may already have released the descriptor on EINTR.
 *operation="Close USB bootloader port";
 return close(fd);
 error:{int saved=errno;close(fd);errno=saved;return -1;}
}
