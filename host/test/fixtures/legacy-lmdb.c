/* Independently creates ordinary LMDB records through the standard C API.
 * No JavaScript LMDB writer is involved. GPL-3.0-or-later. */
#include <lmdb.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
static void check(int code) { if(code) { fprintf(stderr,"C fixture LMDB error %d\n",code); exit(1); } }
static void put(MDB_txn *t, MDB_dbi db, const char *key, const void *bytes, size_t length) {
 MDB_val k={strlen(key),(void *)key},v={length,(void *)bytes}; check(mdb_put(t,db,&k,&v,0));
}
int main(int argc,char **argv) {
 if(argc!=2&&argc!=3)return 2;MDB_env *env;MDB_txn *txn;MDB_dbi moon,values,users;
 check(mdb_env_create(&env));check(mdb_env_set_maxdbs(env,100));check(mdb_env_set_mapsize(env,200*1024*1024));check(mdb_env_open(env,argv[1],0,0600));check(mdb_txn_begin(env,NULL,0,&txn));
 check(mdb_dbi_open(txn,"moonraker",MDB_CREATE,&moon));check(mdb_dbi_open(txn,"values",MDB_CREATE,&values));check(mdb_dbi_open(txn,"authorized_users",MDB_CREATE,&users));
 const char *metadata="{\"protected_namespaces\":[\"moonraker\"],\"forbidden_namespaces\":[\"database\"],\"unsafe_shutdowns\":9007199254740993,\"one_float\":1.0,\"exponent_float\":1e0,\"negative_zero\":-0.0}";
 put(txn,moon,"database",metadata,strlen(metadata));unsigned char version[9]={'q'};int64_t v=1;memcpy(version+1,&v,8);put(txn,moon,"database_version",version,9);
 const char *api="{\"api_key\":\"00112233445566778899aabbccddeeff\",\"created_on\":1700000000.0}";put(txn,users,"_API_KEY_USER_",api,strlen(api));
 unsigned char q[9]={'q'};v=INT64_MAX;memcpy(q+1,&v,8);put(txn,values,"signed64",q,9);v=INT64_MIN;memcpy(q+1,&v,8);put(txn,values,"negative64",q,9);
 const char *nested="{\"exact\":9007199254740993}";put(txn,values,"nested",nested,strlen(nested));
 if(argc==3){if(strcmp(argv[2],"bulk")!=0)return 2;char key[32];unsigned char payload[1024];memset(payload,'K',sizeof(payload));payload[0]='s';for(int i=0;i<30000;i++){snprintf(key,sizeof(key),"bulk_%06d",i);put(txn,values,key,payload,sizeof(payload));}}
 check(mdb_txn_commit(txn));check(mdb_env_sync(env,1));mdb_env_close(env);return 0;
}
