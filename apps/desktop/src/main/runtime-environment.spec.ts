import { describe, expect, it } from 'vitest';

import { cloudSyncEndpoint, getRuntimeEnvironment, isVisualQaRun } from './runtime-environment';

describe('runtime environment', () => {
  it('usa teste apenas com o argumento explícito', () => {
    expect(getRuntimeEnvironment(['GTRZ System.exe'])).toBe('production');
    expect(getRuntimeEnvironment(['GTRZ System.exe', '--gtrz-environment=test'])).toBe('test');
  });

  it('mantém endpoints distintos para cada ambiente', () => {
    expect(cloudSyncEndpoint('production')).toBe(
      'https://muhzjnveqrahccoisddo.supabase.co/functions/v1/gtrz-sync-fallback',
    );
    expect(cloudSyncEndpoint('test')).toBe('https://gtrz-sync-test.jvgacontato.workers.dev');
  });

  it('só ativa a verificação visual com um argumento explícito', () => {
    expect(isVisualQaRun(['GTRZ System.exe'])).toBe(false);
    expect(isVisualQaRun(['GTRZ System.exe', '--gtrz-visual-qa'])).toBe(true);
  });
});
