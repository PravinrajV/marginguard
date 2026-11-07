export const FIXTURE_CAPTURE_PREFIX = 'FIXTURE-CAP-';
export function isSandboxCapture(captureId: string): boolean {
  return !captureId.startsWith(FIXTURE_CAPTURE_PREFIX);
}
