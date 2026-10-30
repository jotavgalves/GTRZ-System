export type RuntimeEnvironment = 'production' | 'test';

const TEST_ARGUMENT = '--gtrz-environment=test';
const VISUAL_QA_ARGUMENT = '--gtrz-visual-qa';
const CANONICAL_PRODUCTION_ENDPOINT =
  'https://muhzjnveqrahccoisddo.supabase.co/functions/v1/gtrz-sync-fallback';

export function getRuntimeEnvironment(argv: readonly string[] = process.argv): RuntimeEnvironment {
  return argv.includes(TEST_ARGUMENT) ? 'test' : 'production';
}

/** Keeps visual QA local state isolated while retaining the production transport. */
export function isVisualQaRun(argv: readonly string[] = process.argv): boolean {
  return argv.includes(VISUAL_QA_ARGUMENT);
}

export function cloudSyncEndpoint(environment: RuntimeEnvironment): string {
  return environment === 'test'
    ? 'https://gtrz-sync-test.jvgacontato.workers.dev'
    : CANONICAL_PRODUCTION_ENDPOINT;
}

export function environmentLabel(environment: RuntimeEnvironment): string {
  return environment === 'test' ? 'GTRZ System - Teste' : 'GTRZ System';
}
