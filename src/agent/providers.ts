// Endpoint shortcuts for the Settings panel. The Rust side decides how to
// talk to a provider from the endpoint's host (src-tauri/src/providers.rs),
// so a preset is only a base URL: nothing here can change where a key goes.

export interface Provider {
  id: 'local' | 'openrouter' | 'openai' | 'anthropic' | 'google';
  name: string;
  endpoint: string;
  /** Exact API host; absent for local and custom servers. */
  host?: string;
  /** Where the user creates a key. Shown as text, never opened by the app. */
  keysPage?: string;
  /** Filled in when the preset is chosen; otherwise the user picks from the list. */
  defaultModel?: string;
}

export const LOCAL_PROVIDER: Provider = {
  id: 'local',
  name: 'Local or custom server',
  endpoint: 'http://localhost:8889/v1',
};

export const PROVIDERS: Provider[] = [
  LOCAL_PROVIDER,
  {
    id: 'openrouter',
    name: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1',
    host: 'openrouter.ai',
    keysPage: 'openrouter.ai/keys',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    host: 'api.openai.com',
    keysPage: 'platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    endpoint: 'https://api.anthropic.com/v1',
    host: 'api.anthropic.com',
    keysPage: 'platform.claude.com/settings/keys',
    defaultModel: 'claude-opus-5-5',
  },
  {
    id: 'google',
    name: 'Google (Gemini)',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    host: 'generativelanguage.googleapis.com',
    keysPage: 'aistudio.google.com/apikey',
  },
];

function parse(endpoint: string): URL | null {
  try {
    const url = new URL(endpoint.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** The hosted provider this endpoint belongs to, or the local/custom entry. */
export function providerFor(endpoint: string): Provider {
  const host = parse(endpoint)?.hostname.toLowerCase();
  return PROVIDERS.find((p) => p.host && p.host === host) ?? LOCAL_PROVIDER;
}

export const isHosted = (endpoint: string) => providerFor(endpoint).id !== 'local';

/** Scheme, host and port: what a saved key is bound to. */
export function endpointOrigin(endpoint: string): string | null {
  return parse(endpoint)?.origin ?? null;
}

/** True when requests stay on this computer. */
export function isLoopback(endpoint: string): boolean {
  const host = parse(endpoint)?.hostname.toLowerCase();
  if (!host) return false;
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}
