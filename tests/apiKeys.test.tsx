import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../src/components/SettingsPanel';
import {
  DEFAULT_SETTINGS,
  pickModel,
  sanitizeSettings,
} from '../src/hooks/useSettings';
import {
  PROVIDERS,
  endpointOrigin,
  isHosted,
  isLoopback,
  providerFor,
} from '../src/agent/providers';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const OPENAI = 'https://api.openai.com/v1';
let savedKey = false;
let models: string[] = [];

beforeEach(() => {
  savedKey = false;
  models = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === 'api_key_status') return savedKey;
    if (command === 'fetch_available_models') return models;
    return undefined;
  });
});
afterEach(cleanup);

function open(settings = DEFAULT_SETTINGS) {
  const onUpdateSettings = vi.fn();
  const onTestConnection = vi.fn().mockResolvedValue(true);
  render(
    <SettingsPanel
      settings={settings}
      onUpdateSettings={onUpdateSettings}
      onResetSettings={vi.fn()}
      onTestConnection={onTestConnection}
      isOpen
      onClose={vi.fn()}
    />,
  );
  return { onUpdateSettings, onTestConnection };
}

describe('providers', () => {
  it('recognizes a hosted provider only by its exact host', () => {
    for (const provider of PROVIDERS) {
      expect(providerFor(provider.endpoint).id).toBe(provider.id);
    }
    expect(providerFor('https://API.OpenAI.com/v1/').id).toBe('openai');
    for (const endpoint of [
      'http://localhost:8000/v1',
      'https://api.openai.com.example.net/v1',
      'https://proxy.example/api.anthropic.com/v1',
      'not a url',
      '',
    ]) {
      expect(providerFor(endpoint).id).toBe('local');
      expect(isHosted(endpoint)).toBe(false);
    }
  });

  it('knows which endpoints keep screenshots on this computer', () => {
    for (const endpoint of [
      'http://localhost:8889/v1',
      'http://127.0.0.1:8000/v1',
      'http://[::1]:8000/v1',
      'http://llm.localhost/v1',
    ]) {
      expect(isLoopback(endpoint)).toBe(true);
    }
    for (const endpoint of [
      'http://192.168.1.20:8000/v1',
      'https://openrouter.ai/api/v1',
      'http://localhost.example.com/v1',
      'http://127.0.0.1.example.com/v1',
    ]) {
      expect(isLoopback(endpoint)).toBe(false);
    }
    expect(endpointOrigin('https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai',
    );
    expect(endpointOrigin('file:///c:/x')).toBeNull();
  });

  it('never picks a hosted model for the user', () => {
    expect(pickModel('', ['pricey-model', 'cheap-model'], OPENAI)).toBeNull();
    expect(
      pickModel('missing', ['loaded.gguf'], 'http://localhost:8889/v1'),
    ).toBe('loaded.gguf');
  });
});

describe('API key', () => {
  it('goes to the credential store and never into settings', async () => {
    models = ['gpt-vision'];
    const { onUpdateSettings, onTestConnection } = open({
      ...DEFAULT_SETTINGS,
      apiEndpoint: OPENAI,
      modelId: 'gpt-vision',
    });
    const field = screen.getByLabelText('API Key') as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.autocomplete).toBe('off');
    const save = screen.getByRole('button', { name: 'Save Key' });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(field, { target: { value: 'sk-test-123' } });
    savedKey = true;
    fireEvent.click(save);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('save_api_key', {
        apiEndpoint: OPENAI,
        apiKey: 'sk-test-123',
      }),
    );
    await waitFor(() =>
      expect(screen.getByText('Key saved for https://api.openai.com')).toBeTruthy(),
    );
    // The field is cleared, the page holds no copy, and nothing key-like was
    // written to settings.
    expect(field.value).toBe('');
    expect(document.body.innerHTML).not.toContain('sk-test-123');
    expect(JSON.stringify(onUpdateSettings.mock.calls)).not.toContain('sk-test');
    expect(onTestConnection).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('delete_api_key', {
        apiEndpoint: OPENAI,
      }),
    );
    await waitFor(() => expect(screen.queryByText(/Key saved for/)).toBeNull());
  });

  it('shows why a key was refused and keeps nothing', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'save_api_key') throw 'Use https:// for example.com.';
      if (command === 'api_key_status') return false;
      return [];
    });
    open({ ...DEFAULT_SETTINGS, apiEndpoint: 'http://example.com/v1' });
    fireEvent.change(screen.getByLabelText('API Key'), {
      target: { value: 'sk-test-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Key' }));
    await waitFor(() =>
      expect(screen.getByText('Use https:// for example.com.')).toBeTruthy(),
    );
    expect(screen.queryByText(/Key saved for/)).toBeNull();
  });

  it('is not part of saved settings, even if a stored file contains one', () => {
    const loaded = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      apiKey: 'sk-leaked',
      api_key: 'sk-leaked',
    });
    expect(JSON.stringify(loaded)).not.toContain('sk-leaked');
    expect(Object.keys(DEFAULT_SETTINGS).join(' ')).not.toMatch(/key/i);
  });
});

describe('provider presets', () => {
  it('switch the endpoint and leave the hosted model for the user to choose', () => {
    const { onUpdateSettings } = open();
    const picker = screen.getByLabelText('Provider') as HTMLSelectElement;
    expect(picker.value).toBe('local');
    expect(screen.getByText(/Screenshots stay on this computer/)).toBeTruthy();

    fireEvent.change(picker, { target: { value: 'openrouter' } });
    expect(onUpdateSettings).toHaveBeenCalledWith({
      apiEndpoint: 'https://openrouter.ai/api/v1',
      modelId: '',
    });
    fireEvent.change(picker, { target: { value: 'anthropic' } });
    expect(onUpdateSettings).toHaveBeenCalledWith({
      apiEndpoint: 'https://api.anthropic.com/v1',
      modelId: 'claude-opus-5-5',
    });
  });

  it('warn that screenshots leave the computer and ask for a model', async () => {
    models = Array.from({ length: 40 }, (_, i) => `vendor/model-${i}`);
    const { onUpdateSettings } = open({
      ...DEFAULT_SETTINGS,
      apiEndpoint: 'https://openrouter.ai/api/v1',
      modelId: '',
    });
    expect(
      screen.getByText(/Screenshots of your screen and your task text are sent to/),
    ).toBeTruthy();
    expect(
      screen.getByText('Choose a vision-capable model before starting a task.'),
    ).toBeTruthy();
    // A long catalog becomes a searchable field, and no model is auto-selected.
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText('Type to search 40 models'),
      ).toBeTruthy(),
    );
    expect(onUpdateSettings).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'vendor/model-7' },
    });
    expect(onUpdateSettings).toHaveBeenCalledWith({ modelId: 'vendor/model-7' });
  });
});
