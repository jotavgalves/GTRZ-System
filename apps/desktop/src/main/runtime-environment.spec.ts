import { describe, expect, it } from 'vitest';

import { cloudSyncEndpoint, getRuntimeEnvironment } from './runtime-environment';

describe('runtime environment', () => {
  it('usa teste apenas com o argumento explícito', () => {
    expect(getRuntimeEnvironment(['GTRZ System.exe'])).toBe('production');
    expect(getRuntimeEnvironment(['GTRZ System.exe', '--gtrz-environment=test'])).toBe('test');
  });

  it('mantém endpoints distintos para cada ambiente', () => {
    expect(cloudSyncEndpoint('production')).toBe('https://gtrz-sync.jvgacontato.workers.dev');
    expect(cloudSyncEndpoint('test')).toBe('https://gtrz-sync-test.jvgacontato.workers.dev');
  });
});
