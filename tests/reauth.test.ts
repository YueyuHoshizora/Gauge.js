import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/index.js';
import { Notifier } from '../src/notify/index.js';
import { Scheduler } from '../src/scheduler/index.js';
import { AppError } from '../src/types.js';
import type { Auth,Provider,QuotaResult } from '../src/types.js';

test('reauthentication during an old refresh cannot overwrite the new grant',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'gauge-reauth-'));const store=new Store(directory);store.updateSettings({push:false});const a=store.create({provider:'codex'});
  const old:Auth={type:'oauth',accessToken:'old-access',refreshToken:'old-refresh',expiresAt:0,extra:{}};const fresh:Auth={...old,accessToken:'fresh-access',refreshToken:'fresh-refresh',expiresAt:Date.now()+3_600_000};store.setAuth(a.id,old);
  const refreshGate=Promise.withResolvers<Auth>();let quotaCalls=0;
  const provider:Provider={refresh(){return refreshGate.promise;},async check(){quotaCalls++;return {windows:[],meta:{}};}};
  const scheduler=new Scheduler(store,new Notifier(store,'mailto:test@example.com'),()=>provider,()=>0.5);
  try{const check=scheduler.check(a.id);store.setAuth(a.id,fresh);refreshGate.resolve({...old,accessToken:'stale-rotated-access',refreshToken:'stale-rotated-refresh',expiresAt:fresh.expiresAt});await check;assert.equal(store.get(a.id).auth?.refreshToken,'fresh-refresh');assert.equal(quotaCalls,0);assert.ok(store.get(a.id).nextCheckAt!<=Date.now()+1000);}finally{await scheduler.stop();store.close();rmSync(directory,{recursive:true,force:true});}
});
test('an old 401 cannot mark a newly reauthenticated account as expired',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'gauge-reauth-'));const store=new Store(directory);store.updateSettings({push:false});const a=store.create({provider:'codex'});const auth:Auth={type:'oauth',accessToken:'old-access',refreshToken:'old-refresh',expiresAt:Date.now()+3_600_000,extra:{}};store.setAuth(a.id,auth);
  const checkGate=Promise.withResolvers<QuotaResult>();const provider:Provider={async refresh(value){return value;},check(){return checkGate.promise;}};const scheduler=new Scheduler(store,new Notifier(store,'mailto:test@example.com'),()=>provider,()=>0.5);
  try{const work=scheduler.check(a.id);store.setAuth(a.id,{...auth,accessToken:'new-access',refreshToken:'new-refresh'});checkGate.reject(new AppError('AUTH_EXPIRED','Expired',401));await work;assert.equal(store.get(a.id).errorCode,null);assert.equal(store.events().length,0);assert.equal(store.get(a.id).auth?.refreshToken,'new-refresh');}finally{await scheduler.stop();store.close();rmSync(directory,{recursive:true,force:true});}
});
