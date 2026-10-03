import { join } from 'node:path';
import { configuration } from './security.js';
import { createApplication } from './routes/index.js';

async function main(): Promise<void> {
  process.umask(0o077);
  const config = configuration();
  const app = createApplication(config);
  try {
    await app.store.backup(join(app.store.directory,`startup-${Date.now()}.db`));
    await new Promise<void>((resolveListen,reject) => { app.server.once('error',reject); app.server.listen(config.port,config.host,() => {app.server.off('error',reject);resolveListen();}); });
    app.scheduler.start();
    console.log(`Gauge.js listening on ${config.host}:${config.port} (${config.cloud ? 'cloud, PIN required' : 'local'})`);
    let closing = false;
    const shutdown = (): void => { if (closing) return; closing = true; void app.close().then(() => {process.exitCode = 0;}).catch(() => { console.error('Gauge.js shutdown failed');process.exitCode = 1; }); };
    process.once('SIGINT',shutdown); process.once('SIGTERM',shutdown);
  } catch (error) { await app.close(); throw error; }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Gauge.js startup failed'); process.exitCode = 1; });
