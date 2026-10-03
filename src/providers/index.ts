import { AppError, type Provider, type ProviderId } from '../types.js';
import { antigravity } from './antigravity.js';
import { claude } from './claude.js';
import { codex } from './codex.js';
import { grok } from './grok.js';
const providers: Record<ProviderId, Provider> = { antigravity, claude, codex, grok };
export function getProvider(id: ProviderId): Provider {
  const provider = Object.hasOwn(providers, id) ? providers[id] : undefined;
  if (!provider) throw new AppError('LOGIN_INPUT', 'Unknown provider.', 400);
  return provider;
}
