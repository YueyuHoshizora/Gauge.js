import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/index.js';
import { Notifier } from '../src/notify/index.js';
import { Scheduler } from '../src/scheduler/index.js';
import { AppError } from '../src/types.js';
import type { Provider, QuotaResult, Auth } from '../src/types.js';

const result: QuotaResult = {windows:[{key:'primary',label:'5h',usedPct:30,remainingPct:70,resetsAt:null}],meta:{plan:'Pro'}};
const auth: Auth = {type:'oauth',accessToken:'first',refreshToken:'refresh-first',expiresAt:Date.now()+3_600_000,extra:{}};
function fixture(provider: Provider, random: () => number = () => 0.5) { const directory=mkdtempSync(join(tmpdir(),'gauge-schedule-')); const store=new Store(directory);store.updateSettings({push:false});const account=store.create({provider:'codex',interval:30});store.setAuth(account.id,auth);const notifier=new Notifier(store,'mailto:test@example.com');const scheduler=new Scheduler(store,notifier,()=>provider,random);return {store,account,scheduler,async close(){await scheduler.stop();store.close();rmSync(directory,{recursive:true,force:true});}}; }
test('simultaneous checks share one request and deletion does not resurrect account',async()=>{
  let resolveCheck: (value:QuotaResult)=>void = ()=>{throw new Error('not initialized');};let requests=0;
  const provider:Provider={async refresh(value){return value;},check(){requests++;return new Promise<QuotaResult>(resolve=>{resolveCheck=resolve;});}};
  const f=fixture(provider);try{const first=f.scheduler.check(f.account.id);const second=f.scheduler.check(f.account.id);assert.equal(first,second);assert.equal(requests,1);f.store.delete(f.account.id);resolveCheck(result);await first;assert.equal(f.store.accounts().length,0);assert.equal(f.store.events().length,0);}finally{await f.close();}
});
test('two refresh cycles commit rotated credentials before the next quota request',async()=>{
  let refreshes=0;let f: ReturnFixture;
  const provider:Provider={async refresh(value){assert.equal(value.refreshToken,refreshes===0?'refresh-first':`refresh-${refreshes}`);refreshes++;return {...value,accessToken:`access-${refreshes}`,refreshToken:`refresh-${refreshes}`,expiresAt:Date.now()+3_600_000};},async check(value){assert.equal(f.store.get(f.account.id).auth?.refreshToken,value.refreshToken);return result;}};
  f=fixture(provider);try{f.store.setAuth(f.account.id,{...auth,expiresAt:0});await f.scheduler.check(f.account.id);const current=f.store.get(f.account.id).auth!;f.store.setAuth(f.account.id,{...current,expiresAt:0});await f.scheduler.check(f.account.id);assert.equal(refreshes,2);assert.equal(f.store.get(f.account.id).auth?.refreshToken,'refresh-2');}finally{await f.close();}
});
interface ReturnFixture {store:Store;account:{id:string};scheduler:Scheduler;close():Promise<void>}
test('429 backs off, preserves stale quota and resets interval after success',async()=>{
  let failed=true;const provider:Provider={async refresh(value){return value;},async check(){if(failed)throw new AppError('RATE_LIMITED','Rate limited',429,120);return result;}};const f=fixture(provider);
  try{f.store.saveQuota(f.account.id,result,1);const before=Date.now();await assert.rejects(f.scheduler.check(f.account.id),{code:'RATE_LIMITED'});let account=f.store.get(f.account.id);assert.equal(account.fetchedAt,1);assert.equal(account.windows[0]?.remainingPct,70);assert.ok(account.nextCheckAt!>=before+120_000);assert.equal(account.errorCode,'RATE_LIMITED');failed=false;const recoveredAt=Date.now();await f.scheduler.check(f.account.id);account=f.store.get(f.account.id);assert.equal(account.error,null);assert.ok(account.nextCheckAt!>=recoveredAt+30_000&&account.nextCheckAt!<recoveredAt+32_000);}finally{await f.close();}
});
test('temporary refresh outages preserve auth, invalid refresh emits deduplicated login event',async()=>{
  let unavailable=true;const provider:Provider={async refresh(){throw unavailable?new AppError('UPSTREAM_ERROR','Unavailable',503):new AppError('AUTH_EXPIRED','Expired',401);},async check(){return result;}};const f=fixture(provider);
  try{f.store.setAuth(f.account.id,{...auth,expiresAt:0});await assert.rejects(f.scheduler.check(f.account.id));assert.equal(f.store.get(f.account.id).errorCode,'UPSTREAM_ERROR');assert.equal(f.store.events().length,0);unavailable=false;await assert.rejects(f.scheduler.check(f.account.id));await assert.rejects(f.scheduler.check(f.account.id));assert.equal(f.store.get(f.account.id).errorCode,'AUTH_EXPIRED');assert.deepEqual(f.store.events().map(event=>event.kind),['auth_expired']);assert.equal(f.store.get(f.account.id).auth?.refreshToken,'refresh-first');}finally{await f.close();}
});
test('backoff jitter respects Retry-After and the thirty-minute cap without capping normal intervals',async()=>{
  let failing=true;
  const provider:Provider={async refresh(value){return value;},async check(){if(failing)throw new AppError('RATE_LIMITED','Limited',429,1800);return result;}};
  for (const random of [()=>0,()=>1]) {
    const f=fixture(provider,random);
    try {
      const before=Date.now();await assert.rejects(f.scheduler.check(f.account.id));
      const scheduled=f.store.get(f.account.id).nextCheckAt!;
      assert.ok(scheduled>=before+1_800_000,'must not retry before Retry-After');
      assert.ok(scheduled<=Date.now()+1_800_000,'jitter must not exceed backoff cap');
      failing=false;f.store.update(f.account.id,{interval:18000});await f.scheduler.check(f.account.id);
      assert.ok(f.store.get(f.account.id).nextCheckAt!>=Date.now()+16_000_000,'ordinary five-hour polling must not be shortened');
      failing=true;
    }finally{await f.close();}
  }
});
