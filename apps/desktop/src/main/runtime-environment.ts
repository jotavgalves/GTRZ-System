export type RuntimeEnvironment = 'production' | 'test';

const TEST_ARGUMENT = '--gtrz-environment=test';

export function getRuntimeEnvironment(argv: readonly string[] = process.argv): RuntimeEnvironment {
  return argv.includes(TEST_ARGUMENT) ? 'test' : 'production';
}

export function cloudSyncEndpoint(environment: RuntimeEnvironment): string {
  return environment === 'test'
    ? 'https://gtrz-sync-test.jvgacontato.workers.dev'
    : 'https://gtrz-sync.jvgacontato.workers.dev';
}

export function environmentLabel(environment: RuntimeEnvironment): string {
  return environment === 'test' ? 'GTRZ System - Teste' : 'GTRZ System';
}
