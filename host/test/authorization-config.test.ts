import test from 'node:test';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {readAuthorizationOptions} from '../src/moonraker/authorization-config.ts';
const reader=(authorization:Record<string,string>={},extra:Record<string,Record<string,string>>={})=>new ConfigurationReader(new ConfigurationSource('/config/main.conf',{DEFAULT:{},server:{},authorization,...extra},[]));
test('authorization configuration consumes typed policy and preserves invalid-source fallback warning',()=>{
 const defaults=reader();assert.deepEqual(readAuthorizationOptions(defaults,'http://printer.test:7125'),{issuer:'http://printer.test:7125',loginTimeoutDays:90,forceLogins:false,enableApiKey:true});assert.equal(defaults.validate().length,0);
 const configured=reader({login_timeout:'30',force_logins:'yes',enable_api_key:'no',max_login_attempts:'3',default_source:'MOONRAKER'});
 assert.deepEqual(readAuthorizationOptions(configured,'https://printer.test'),{issuer:'https://printer.test',loginTimeoutDays:30,forceLogins:true,enableApiKey:false,maxLoginAttempts:3});assert.equal(configured.validate().length,0);
 const fallback=reader({default_source:'typo'});readAuthorizationOptions(fallback,'http://printer.test');assert.match(fallback.warnings()[0],/falling back/);
});
test('authorization configuration rejects unsupported access rules, LDAP, invalid ranges and unstable issuer shapes',()=>{
 const invalid:Record<string,string>[]=[{max_login_attempts:'0'},{login_timeout:'0'},{login_timeout:'3651'},{force_logins:'perhaps'},{enable_api_key:'perhaps'},{trusted_clients:'printer.example.com'},{cors_domains:'['},{default_source:'ldap'},{unknown:'value'}];for(const options of invalid)assert.throws(()=>readAuthorizationOptions(reader(options),'http://printer.test'));
 assert.throws(()=>readAuthorizationOptions(reader({},{ldap:{}}),'http://printer.test'),/LDAP/);
 for(const issuer of ['not-url','file:///printer','http://printer.test/','http://printer.test/path','http://user:pass@printer.test'])assert.throws(()=>readAuthorizationOptions(reader(),issuer),/issuer/);
});
