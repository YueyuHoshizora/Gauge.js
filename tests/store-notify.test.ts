import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store/index.js';
import { Notifier } from '../src/notify/index.js';
import type { QuotaWindow, Auth } from '../src/types.js';

function fixture() { const directory = mkdtempSync(join(tmpdir(),'gauge-store-')); const store = new Store(directory); return {directory,store,close() {store.close();rmSync(directory,{recursive:true,force:true});}}; }
const auth: Auth = {type:'oauth',accessToken:'sensitive-access',refreshToken:'sensitive-refresh',expiresAt:Date.now()+3_600_000,extra:{accountId:'private-extra'}};
const window = (remainingPct: number, resetsAt: string|null = null): QuotaWindow => ({key:'five_hour',label:'Five hours',usedPct:100-remainingPct,remainingPct,resetsAt});
test('credentials persist but public projection stays redacted; samples are bounded and ordered', () => {
  const f = fixture(); try {
    const account = f.store.create({provider:'codex',label:'Primary'}); f.store.setAuth(account.id,auth);
    for (let t=1;t<=205;t++) f.store.saveQuota(account.id,{windows:[window(t%100)],meta:{}},t);
    const safe = f.store.public(f.store.get(account.id));
    assert.equal(safe.authenticated,true); assert.equal(safe.samples.length,200); assert.equal(safe.samples[0]?.t,6); assert.equal(safe.samples.at(-1)?.t,205);
    assert.equal(JSON.stringify(safe).includes('sensitive'),false); assert.equal('auth' in safe,false);
    assert.equal(f.store.get(account.id).auth?.refreshToken,auth.refreshToken);
    assert.equal(statSync(f.store.filename).mode & 0o777,0o600);
    assert.equal(statSync(f.directory).mode & 0o777,0o700);
    f.store.delete(account.id); assert.deepEqual(f.store.db.prepare('SELECT * FROM samples').all(),[]);
  } finally {f.close();}
});
test('snapshot restores persisted accounts, preferences and latest rotating token', async () => {
  const f=fixture(); const destination=join(f.directory,'snapshot.db');
  try { const a=f.store.create({provider:'grok',label:'Backup account'}); f.store.setAuth(a.id,{...auth,refreshToken:'rotated-latest'}); f.store.updateSettings({defaultLocale:'ja'}); await f.store.backup(destination);
    const restored=new DatabaseSync(destination); try { const row=restored.prepare('SELECT auth_json,label FROM accounts WHERE id=?').get(a.id); assert.equal(row?.label,'Backup account'); assert.equal(JSON.parse(String(row?.auth_json)).refreshToken,'rotated-latest'); assert.equal(JSON.parse(String(restored.prepare("SELECT value FROM settings WHERE key='preferences'").get()?.value)).defaultLocale,'ja'); } finally {restored.close();}
    assert.equal(statSync(destination).mode&0o777,0o600); await assert.rejects(f.store.backup(destination));
  } finally {f.close();}
});
test('threshold and Claude interval boundaries cannot silently corrupt preferences', () => { const f=fixture();try {
  assert.throws(()=>f.store.create({provider:'claude',interval:30}));
  f.store.updateSettings({advancedIntervals:true}); const a=f.store.create({provider:'claude',interval:30});assert.equal(a.interval,30);
  assert.throws(()=>f.store.update(a.id,{thresholds:{lowPct:90,recoverPct:20}}));assert.equal(f.store.get(a.id).thresholds.lowPct,20);
  assert.throws(()=>f.store.updateSettings({authPin:'must-not-store'}));assert.equal(f.store.settings().defaultLocale,'zh-TW');
}finally{f.close();}});
test('low latch survives intermediate recovery and restart; cooldown suppresses repeated crossings', async () => {
  const f=fixture(); try {
    f.store.updateSettings({push:false}); const a=f.store.create({provider:'codex'}); const notifier=new Notifier(f.store,'mailto:test@example.com');
    const observe=async (pct:number,t:number) => {const previous=f.store.get(a.id).windows;f.store.saveQuota(a.id,{windows:[window(pct)],meta:{}},t);await notifier.quota(f.store.get(a.id),previous,t);};
    await observe(80,1);await observe(10,2);await observe(50,3); assert.deepEqual(f.store.events().map(e=>e.kind),['low']);
    const afterRestart=new Notifier(f.store,'mailto:test@example.com');const previous=f.store.get(a.id).windows;f.store.saveQuota(a.id,{windows:[window(95)],meta:{}},4);await afterRestart.quota(f.store.get(a.id),previous,4);
    assert.deepEqual(f.store.events().map(e=>e.kind),['recovered','low']);
    await observe(10,5);await observe(95,6);assert.equal(f.store.events().length,2);
    await observe(10,6*3_600_000+10);assert.equal(f.store.events().length,3);
  } finally {f.close();}
});
test('expired reset permits genuine recovery below recovery threshold, not continued depletion', async () => {
  const f=fixture();try{f.store.updateSettings({push:false});const a=f.store.create({provider:'claude'});const notifier=new Notifier(f.store,'mailto:test@example.com');
    f.store.saveQuota(a.id,{windows:[window(5,new Date(1000).toISOString())],meta:{}},500);await notifier.quota(f.store.get(a.id),[],500);assert.equal(f.store.events().length,0);
    const previous=f.store.get(a.id).windows;f.store.saveQuota(a.id,{windows:[window(60)],meta:{}},2000);await notifier.quota(f.store.get(a.id),previous,2000);assert.equal(f.store.events()[0]?.kind,'recovered');
  }finally{f.close();}
});
