import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import type { Server, IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../src/routes/index.js';
import { configuration } from '../src/security.js';

async function call(server:Server,path:string,method='GET',data?:unknown,headers:IncomingHttpHeaders={}) {
  const port=(server.address() as AddressInfo).port;
  return new Promise<{status:number;body:Record<string,unknown>;headers:IncomingHttpHeaders}>((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port,path,method,headers:{Host:'localhost:8787',...(data===undefined?{}:{'Content-Type':'application/json'}),...headers}},res=>{let text='';res.setEncoding('utf8');res.on('data',(chunk:string)=>{text+=chunk;});res.on('end',()=>{let body:Record<string,unknown>={};try{body=JSON.parse(text) as Record<string,unknown>;}catch{body={text};}resolve({status:res.statusCode??0,body,headers:res.headers});});});req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));
  });
}
test('HTTP authorization, origin rejection, account durability and credential redaction',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'gauge-http-'));const app=createApplication(configuration({GAUGE_PIN:'long-test-access-pin',GAUGE_DATA_DIR:directory}));await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const headers={Authorization:'Bearer long-test-access-pin'};
  try{
    assert.equal((await call(app.server,'/api/status')).status,401);
    assert.equal((await call(app.server,'/api/accounts','POST',{provider:'codex'},{...headers,Origin:'https://evil.example'})).status,403);
    assert.equal((await call(app.server,'/api/status','GET',undefined,{...headers,Host:'evil.example'})).status,403);
    const created=await call(app.server,'/api/accounts','POST',{provider:'codex',label:'Main'},headers);assert.equal(created.status,201);const account=created.body.account as {id:string};
    assert.equal((await call(app.server,`/api/accounts/${account.id}/check`,'POST',undefined,headers)).status,409);
    app.store.setAuth(account.id,{type:'oauth',accessToken:'private-access-123',refreshToken:'private-refresh-123',expiresAt:Date.now()+3_600_000,extra:{secret:'private-extra-123'}});
    const status=await call(app.server,'/api/status','GET',undefined,headers);assert.equal(status.status,200);assert.equal(status.headers['cache-control'],'no-store');assert.equal(JSON.stringify(status.body).includes('private-'),false);assert.equal(JSON.stringify(status.body).includes('long-test-access-pin'),false);
    assert.equal((await call(app.server,`/api/accounts/${account.id}`,'PATCH',{label:'Renamed'},headers)).status,200);assert.equal(app.store.get(account.id).label,'Renamed');
    assert.equal((await call(app.server,'/api/login/claude/start','POST',{accountId:account.id},headers)).status,400);
    assert.equal((await call(app.server,'/api/push/subscribe','POST',{endpoint:'https://127.0.0.1/metadata',keys:{p256dh:'bad',auth:'bad'}},headers)).status,400);
    assert.equal((await call(app.server,'/api/settings','PUT',{vapid:{privateKey:'evil'}},headers)).status,400);
    assert.equal((await call(app.server,`/api/accounts/${account.id}`,'DELETE',undefined,headers)).status,200);assert.equal(app.store.accounts().length,0);
    assert.equal((await call(app.server,'/data/gauge.db')).status,404);assert.equal((await call(app.server,'/%2eenv')).status,404);
  }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});
test('cloud cannot start without strong PIN/HTTPS origin and registers no callback',async()=>{
  assert.throws(()=>configuration({GAUGE_CLOUD:'1'}));assert.throws(()=>configuration({GAUGE_CLOUD:'1',GAUGE_PIN:'12345678',GAUGE_ORIGIN:'http://example.com'}));assert.throws(()=>configuration({HOST:'0.0.0.0'}));
  const directory=mkdtempSync(join(tmpdir(),'gauge-cloud-'));const app=createApplication(configuration({GAUGE_CLOUD:'1',GAUGE_PIN:'strong-enough-pin',GAUGE_ORIGIN:'https://gauge.example',GAUGE_DATA_DIR:directory}));await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  try{assert.equal((await call(app.server,'/callback?code=example&state=example','GET',undefined,{Host:'gauge.example'})).status,404);assert.equal((await call(app.server,'/api/status','GET',undefined,{Host:'gauge.example'})).status,401);assert.equal((await call(app.server,'/api/status','GET',undefined,{Host:'gauge.example',Authorization:'Bearer strong-enough-pin'})).status,200);}finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});
