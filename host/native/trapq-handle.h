#ifndef ANYRAID_TRAPQ_HANDLE_H
#define ANYRAID_TRAPQ_HANDLE_H
#include <node_api.h>
#include <stddef.h>
#include "trapq.h"
// Shared ABI between the queue and step-compression Node-API modules.
static const napi_type_tag trapq_tag={0x4179726169645451ULL,0x32363039323003ULL};
struct solver_link {double generated,retention;struct solver_link *next;};
struct trap_handle {struct trapq *q;double end,finalized;size_t nodes;int owner_live;struct solver_link *solvers;};
#endif
