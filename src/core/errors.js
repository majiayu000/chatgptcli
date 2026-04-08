export const ERROR_CODE = {
  INPUT_INVALID: 'INPUT_INVALID',
  AUTH_MISSING: 'AUTH_MISSING',
  AUTH_INVALID: 'AUTH_INVALID',
  NETWORK_ERROR: 'NETWORK_ERROR',
  API_ERROR: 'API_ERROR',
  CONFIG_INVALID: 'CONFIG_INVALID',
  UNKNOWN: 'UNKNOWN'
};

export const EXIT_CODE = {
  SUCCESS: 0,
  GENERIC: 1,
  INPUT_INVALID: 2,
  AUTH: 3,
  NETWORK: 4,
  API: 5,
  CONFIG: 6
};

export class AppError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.hint = extra.hint;
    this.details = extra.details;
    this.cause = extra.cause;
  }
}

export function toAppError(err) {
  if (err instanceof AppError) return err;

  if (err instanceof Error && err.name === 'AbortError') {
    return new AppError(ERROR_CODE.NETWORK_ERROR, 'Request timed out', {
      hint: 'Increase --timeout or retry.'
    });
  }

  if (err instanceof TypeError) {
    return new AppError(ERROR_CODE.NETWORK_ERROR, err.message || 'Network error', {
      hint: 'Check local browser bridge connectivity and your network.'
    });
  }

  const message = err instanceof Error ? err.message : String(err);
  return new AppError(ERROR_CODE.UNKNOWN, message || 'Unknown error');
}

export function exitCodeForError(err) {
  switch (err.code) {
    case ERROR_CODE.INPUT_INVALID:
      return EXIT_CODE.INPUT_INVALID;
    case ERROR_CODE.AUTH_MISSING:
    case ERROR_CODE.AUTH_INVALID:
      return EXIT_CODE.AUTH;
    case ERROR_CODE.NETWORK_ERROR:
      return EXIT_CODE.NETWORK;
    case ERROR_CODE.API_ERROR:
      return EXIT_CODE.API;
    case ERROR_CODE.CONFIG_INVALID:
      return EXIT_CODE.CONFIG;
    default:
      return EXIT_CODE.GENERIC;
  }
}
