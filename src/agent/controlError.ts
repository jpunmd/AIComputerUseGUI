interface ScreenChangedError {
  code: 'screen_changed';
  message: string;
  input_may_have_been_sent: boolean;
}

// Accept only structured native failures, never matching model/error prose.
export function isScreenChanged(error: unknown): error is ScreenChangedError {
  if (!error || typeof error !== 'object') return false;
  const value = error as Record<string, unknown>;
  return (
    value.code === 'screen_changed' &&
    typeof value.message === 'string' &&
    typeof value.input_may_have_been_sent === 'boolean'
  );
}

export function errorMessage(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  )
    return error.message;
  return String(error);
}
