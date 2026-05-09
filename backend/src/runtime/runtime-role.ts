export type AppRuntimeCapability = 'api' | 'worker' | 'scheduler';

const ALL_CAPABILITIES: AppRuntimeCapability[] = ['api', 'worker', 'scheduler'];

function normalizeToken(raw: string): AppRuntimeCapability | 'all' | null {
  const token = String(raw || '').trim().toLowerCase();
  if (!token) return null;
  if (token === 'all') return 'all';
  if (token === 'api') return 'api';
  if (token === 'worker') return 'worker';
  if (token === 'scheduler') return 'scheduler';
  return null;
}

export function getAppRuntimeCapabilities(): Set<AppRuntimeCapability> {
  const raw = String(process.env.APP_RUNTIME_ROLE || 'all').trim();
  if (!raw) return new Set(ALL_CAPABILITIES);

  const tokens = raw
    .split(',')
    .map((part) => normalizeToken(part))
    .filter((part): part is AppRuntimeCapability | 'all' => part !== null);

  if (!tokens.length || tokens.includes('all')) {
    return new Set(ALL_CAPABILITIES);
  }

  return new Set(tokens as AppRuntimeCapability[]);
}

export function runtimeHasCapability(capability: AppRuntimeCapability): boolean {
  return getAppRuntimeCapabilities().has(capability);
}

export function runtimeCapabilitiesLabel(): string {
  return Array.from(getAppRuntimeCapabilities()).sort().join(',');
}

export function getRuntimeInstanceId(): string {
  const explicit = String(process.env.SERVICE_INSTANCE_ID || '').trim();
  if (explicit) return explicit;

  const host = String(
    process.env.HOSTNAME || process.env.COMPUTERNAME || 'runtime',
  ).trim();
  return `${host}:${process.pid}`;
}
