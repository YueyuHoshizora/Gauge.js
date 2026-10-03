import { Store } from '../src/store/index.js';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

async function main(): Promise<void> {
  process.umask(0o077);
  const destination = process.argv[2];
  if (!destination) throw new Error('Usage: npm run backup -- /secure/path/new-backup.db');
  const directory = process.env.GAUGE_DATA_DIR ?? 'data';
  if (!existsSync(join(resolve(directory),'gauge.db'))) throw new Error('No existing Gauge.js database found');
  const store = new Store(directory);
  try { await store.backup(destination); console.log('Consistent database backup created (0600).'); } finally { store.close(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Backup failed'); process.exitCode = 1; });
