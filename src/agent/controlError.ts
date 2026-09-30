interface ControlError<Code extends string> {
  code: Code;
  message: string;
  input_may_have_been_sent: boolean;
}

// Accept only structured native failures, never matching model/error prose.
function isControlError<Code extends string>(
  error: unknown,
  code: Code,
): error is ControlError<Code> {
  if (!error || typeof error !== 'object') return false;
  const value = error as Record<string, unknown>;
  return (
    value.code === code &&
    typeof value.message === 'string' &&
    typeof value.input_may_have_been_sent === 'boolean'
  );
}

export function isScreenChanged(
  error: unknown,
): error is ControlError<'screen_changed'> {
  return isControlError(error, 'screen_changed');
}

// A proposal the model can correct (bad key, no focused target, the
// controller's own window). Only safe to retry when no input was sent.
export function isInvalidProposal(
  error: unknown,
): error is ControlError<'invalid_proposal'> {
  return isControlError(error, 'invalid_proposal');
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
