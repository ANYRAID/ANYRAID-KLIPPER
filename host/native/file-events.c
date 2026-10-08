// Linux directory event bridge for the Node host.
// Copyright (C) 2026 ANYRAID. GPL-3.0-or-later.
#define _GNU_SOURCE
#include <node_api.h>
#include <uv.h>
#include <sys/inotify.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdint.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
typedef struct {
 uv_poll_t poll;
 napi_env env;
 napi_ref callback;
 napi_async_context context;
 int fd,closing,closed,finalized,hook;
} events_t;
static const napi_type_tag tag={0x526b92bf55c19431ULL,0xa4c8f87271308712ULL};
static void stop_events(events_t *owner);
static void release_owner(events_t *owner){if(owner->closed&&
 owner->finalized)free(owner);}
static void notify(events_t *owner,const void *bytes,size_t length,const
 char *error){
 if(!owner->env||!owner->callback)return;
 napi_env env=owner->env;napi_handle_scope scope;
 if(napi_open_handle_scope(env,&scope)!=napi_ok)return;
 napi_value callback,receiver,args[2],result;
 napi_status status=napi_get_reference_value(env,owner->callback,&callback);
 if(status==napi_ok)status=napi_get_global(env,&receiver);
 if(status==napi_ok)status=bytes?napi_create_buffer_copy(env,length,bytes,
 NULL,&args[0]):napi_get_null(env,&args[0]);
 if(status==napi_ok)status=error?napi_create_string_utf8(env,error,
 NAPI_AUTO_LENGTH,&args[1]):napi_get_null(env,&args[1]);
 if(status==napi_ok)status=napi_make_callback(env,owner->context,receiver,
 callback,2,args,&result);
 if(status==napi_pending_exception){napi_value exception;
 if(napi_get_and_clear_last_exception(env,&exception)==napi_ok)
 napi_fatal_exception(env,exception);}
 napi_close_handle_scope(env,scope);
}
static void cleanup(void *data){events_t *owner=data;
 if(owner->context){napi_async_destroy(owner->env,owner->context);}
 owner->context=NULL;
 owner->hook=0;owner->env=NULL;owner->callback=NULL;stop_events(owner);}
static void closed(uv_handle_t *handle){
 events_t *owner=handle->data;
 notify(owner,NULL,0,NULL);
 if(owner->env){if(owner->callback)napi_delete_reference(owner->env,
 owner->callback);if(owner->context)napi_async_destroy(owner->env,
 owner->context);if(owner->hook)napi_remove_env_cleanup_hook(owner->env,
 cleanup,owner);}
 owner->context=NULL;
 owner->callback=NULL;owner->hook=0;owner->env=NULL;owner->closed=1;
 release_owner(owner);
}
static void stop_events(events_t *owner){
 if(owner->closing)return;
 owner->closing=1;uv_poll_stop(&owner->poll);
 if(owner->fd>=0){close(owner->fd);owner->fd=-1;}
 uv_close((uv_handle_t *)&owner->poll,closed);
}
static void finalize(napi_env env,void *data,void *hint){
 (void)env;(void)hint;events_t *owner=data;owner->finalized=1;
 if(owner->closed){release_owner(owner);return;}stop_events(owner);
}
static void ready(uv_poll_t *poll,int status,int events){
 events_t *owner=poll->data;if(owner->closing)return;
 if(status<0){notify(owner,NULL,0,uv_strerror(status));stop_events(owner);
 return;}
 if(!(events&UV_READABLE))return;
 // One bounded read per loop callback. Level-triggered poll schedules the next
 // chunk; large event storms never spin an unbounded drain loop in JavaScript.
 unsigned char bytes[65536];ssize_t size=read(owner->fd,bytes,sizeof(bytes));
 if(size<0&&(errno==EAGAIN||errno==EINTR))return;
 if(size<=0){notify(owner,NULL,0,size<0?strerror(errno)
 :"Inotify stream ended");stop_events(owner);return;}
 notify(owner,bytes,(size_t)size,NULL);
}
static napi_value error(napi_env env,const char *message){
 napi_throw_error(env,NULL,message);return NULL;}
static napi_value syscall_error(napi_env env,const char *operation){char
 message[256];snprintf(message,sizeof(message),"%s: %s",operation,
 strerror(errno));return error(env,message);}
static int integer(napi_env env,napi_value value,int *result){double number;
 if(napi_get_value_double(env,value,&number)!=napi_ok||!isfinite(number)||
 number<0||number>INT_MAX||floor(number)!=number){return 0;}*result=(int)
 number;return 1;}
static events_t *owner(napi_env env,napi_value value){bool matches=false;
 events_t *result=NULL;
 // The checked tag must precede unwrap: other native externals are not ours.
 if(napi_check_object_type_tag(env,value,&tag,&matches)!=napi_ok||!matches){
 napi_throw_type_error(env,NULL,"Invalid directory event owner");return NULL;}
 if(napi_unwrap(env,value,(void **)&result)!=napi_ok||!result){
 napi_throw_type_error(env,NULL,"Invalid directory event owner");return NULL;
 }return result;
}
static napi_value create(napi_env env,napi_callback_info info){
 size_t count=1;napi_value args[1],result,resource,name;napi_valuetype type;
 if(napi_get_cb_info(env,info,&count,args,NULL,NULL)!=napi_ok||count!=1||
 napi_typeof(env,args[0],&type)!=napi_ok||type!=napi_function)return
 error(env,"Directory event callback required");
 events_t *state=calloc(1,sizeof(*state));if(!state)return error(env,
 "Directory event allocation failed");state->env=env;
 state->fd=inotify_init1(IN_NONBLOCK|IN_CLOEXEC);
 if(state->fd<0){free(state);return syscall_error(env,"Create inotify owner");}
 uv_loop_t *loop;int status=napi_get_uv_event_loop(env,&loop)
 ==napi_ok?uv_poll_init(loop,&state->poll,state->fd):UV_EINVAL;
 if(status){close(state->fd);free(state);return error(env,uv_strerror(status)
 );}state->poll.data=state;
 if(napi_create_reference(env,args[0],1,&state->callback)!=napi_ok||
 napi_create_object(env,&result)!=napi_ok||napi_type_tag_object(env,result,&
 tag)!=napi_ok){state->finalized=1;stop_events(state);return error(env,
 "Directory event initialization failed");}
 if(napi_create_object(env,&resource)!=napi_ok||napi_create_string_utf8(env,
 "ANYRAID_FILE_EVENTS",NAPI_AUTO_LENGTH,&name)!=napi_ok||napi_async_init(env,
 resource,name,&state->context)!=napi_ok){state->finalized=1;
 stop_events(state);return error(env,"Directory event async context failed");}
 if(napi_wrap(env,result,state,finalize,NULL,NULL)!=napi_ok){
 state->finalized=1;stop_events(state);return error(env,
 "Directory event wrapping failed");}
 if(napi_add_env_cleanup_hook(env,cleanup,state)!=napi_ok){stop_events(state)
 ;return error(env,"Directory event cleanup registration failed");}
 state->hook=1;
 status=uv_poll_start(&state->poll,UV_READABLE,ready);if(status){
 stop_events(state);return error(env,uv_strerror(status));}
 uv_unref((uv_handle_t *)&state->poll);return result;
}
static napi_value add(napi_env env,napi_callback_info info){
 size_t count=2;napi_value args[2],result;int input;
 if(napi_get_cb_info(env,info,&count,args,NULL,NULL)!=napi_ok||count!=2||
 !integer(env,args[1],&input))return error(env,
 "Directory descriptor required");
 events_t *state=owner(env,args[0]);if(!state)return NULL;if(state->closing)
 return error(env,"Directory events closed");
 // Duplicate first so an unrelated asynchronous close cannot reuse the input
 // descriptor between type verification and registering the anchored path.
 int fd=fcntl(input,F_DUPFD_CLOEXEC,3);if(fd<0)return syscall_error(env,
 "Duplicate watched directory");struct stat metadata;
 if(fstat(fd,&metadata)||!S_ISDIR(metadata.st_mode)){close(fd);return
 error(env,"Watch source must be a directory");}
 char path[64];snprintf(path,sizeof(path),"/proc/self/fd/%d/.",fd);
 uint32_t mask=IN_OPEN|IN_MODIFY|IN_CLOSE_WRITE|IN_CREATE|IN_DELETE|
 IN_MOVED_FROM|IN_MOVED_TO|IN_DELETE_SELF|IN_MOVE_SELF|IN_UNMOUNT|IN_ONLYDIR;
 int wd=inotify_add_watch(state->fd,path,mask),saved=errno;close(fd);
 errno=saved;if(wd<0)return syscall_error(env,"Add directory watch");
 if(napi_create_int32(env,wd,&result)!=napi_ok)return error(env,
 "Directory watch result failed");
 return result;
}
static napi_value remove_watch(napi_env env,napi_callback_info info){
 size_t count=2;napi_value args[2],result;int wd;
 if(napi_get_cb_info(env,info,&count,args,NULL,NULL)!=napi_ok||count!=2||
 !integer(env,args[1],&wd))return error(env,"Watch identifier required");
 events_t *state=owner(env,args[0]);if(!state)return NULL;if(!state->closing&&
 inotify_rm_watch(state->fd,wd)&&errno!=EINVAL)return syscall_error(env,
 "Remove directory watch");napi_get_undefined(env,&result);return result;
}
static napi_value close_events(napi_env env,napi_callback_info info){size_t
 count=1;napi_value args[1],result;if(napi_get_cb_info(env,info,&count,args,
 NULL,NULL)!=napi_ok||count!=1)return error(env,"Event owner required");
 events_t *state=owner(env,args[0]);if(!state)return NULL;stop_events(state);
 napi_get_undefined(env,&result);return result;}
static napi_value init(napi_env env,napi_value exports){
 napi_property_descriptor methods[]={
 {"create",NULL,create,NULL,NULL,NULL,napi_default,NULL},
 {"add",NULL,add,NULL,NULL,NULL,napi_default,NULL},
 {"remove",NULL,remove_watch,NULL,NULL,NULL,napi_default,NULL},
 {"close",NULL,close_events,NULL,NULL,NULL,napi_default,NULL}};
 if(napi_define_properties(env,exports,4,methods)!=napi_ok)return error(env,
 "File events registration failed");
 return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
