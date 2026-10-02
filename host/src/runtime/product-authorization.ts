import {DatabaseStore} from '../moonraker/database.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {readAuthorizationOptions} from '../moonraker/authorization-config.ts';
import type {ProductServerOptions} from './product-service.ts';
/** Machine bindings select one authorization owner. Validate before MCU access. */
export function assertProductAuthorization(server:ProductServerOptions|undefined,notifications=false,reader?:ConfigurationReader):void{
 if(!server)throw new TypeError('Product server authorization is required');
 if(server.authorization!==undefined){
  const config=server.authorization;
  if(!config||typeof config!=='object'||typeof config.issuer!=='string'||!(server.database instanceof DatabaseStore)||server.database.status.closed||server.database.status.closing||server.database.status.restoreState!=='ready')throw new TypeError('Native product authorization requires an open database and stable issuer');
  for(const key of ['authorize','authorizeNotification','authorizeSubscriptionConnection'])if(key in server)throw new TypeError('Native product authorization cannot share external callbacks');
  let origin:URL;try{origin=new URL(config.issuer);}catch{throw new TypeError('Invalid product authorization issuer');}
  if(!['http:','https:'].includes(origin.protocol)||origin.origin!==config.issuer)throw new TypeError('Invalid product authorization issuer');
  if(reader)readAuthorizationOptions(reader,config.issuer);
 }else if(typeof server.authorize!=='function'||notifications&&typeof server.authorizeNotification!=='function')throw new TypeError('Explicit product authorization callbacks are required');
}
