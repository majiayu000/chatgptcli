import { AppError, ERROR_CODE, EXIT_CODE, exitCodeForError, toAppError } from './core/errors.js';
import { runAsk } from './commands/ask.js';
import { runDoctor } from './commands/doctor.js';
import { runSetup } from './commands/setup.js';

const VERSION = '0.1.0';

export async function runCli(argv) {
  const command = argv[0];

  if (!command || command === '-h' || command === '--help') {
    writeStdout(helpText());
    return EXIT_CODE.SUCCESS;
  }

  if (command === '-v' || command === '--version') {
    writeStdout(VERSION);
    return EXIT_CODE.SUCCESS;
  }

  try {
    if (command === 'ask') {
      const result = await runAsk(parseAskArgs(argv.slice(1)));
      writeStdout(result.output);
      return result.exitCode;
    }

    if (command === 'doctor') {
      return runDoctor(parseDoctorArgs(argv.slice(1)));
    }

    if (command === 'setup') {
      return runSetup(parseSetupArgs(argv.slice(1)));
    }

    throw new AppError(ERROR_CODE.INPUT_INVALID, `Unknown command: ${command}`, {
      hint: 'Use --help to see supported commands.'
    });
  } catch (error) {
    const err = toAppError(error);
    writeStderr(`${err.code}: ${err.message}`);
    if (err.hint) {
      writeStderr(`Hint: ${err.hint}`);
    }
    return exitCodeForError(err);
  }
}

function parseAskArgs(args) {
  const positional = [];
  let format = 'json';
  let timeoutSeconds = 120;
  let newChat = false;
  let maxAttempts = 5;
  let retryDelayMs = 1500;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }

    if (token === '--new') {
      newChat = true;
      continue;
    }

    if (token === '--timeout') {
      const raw = requireValue(args, i, '--timeout');
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        throw new AppError(ERROR_CODE.INPUT_INVALID, 'Invalid --timeout value', {
          hint: 'Use a positive number of seconds.'
        });
      }
      timeoutSeconds = Math.floor(value);
      i += 1;
      continue;
    }

    if (token === '--max-attempts') {
      const raw = requireValue(args, i, '--max-attempts');
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        throw new AppError(ERROR_CODE.INPUT_INVALID, 'Invalid --max-attempts value', {
          hint: 'Use a positive integer like 5.'
        });
      }
      maxAttempts = Math.floor(value);
      i += 1;
      continue;
    }

    if (token === '--retry-delay-ms') {
      const raw = requireValue(args, i, '--retry-delay-ms');
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        throw new AppError(ERROR_CODE.INPUT_INVALID, 'Invalid --retry-delay-ms value', {
          hint: 'Use a non-negative integer like 1500.'
        });
      }
      retryDelayMs = Math.floor(value);
      i += 1;
      continue;
    }

    if (token === '-f' || token === '--format') {
      const next = requireValue(args, i, '--format');
      if (next !== 'json' && next !== 'text') {
        throw new AppError(ERROR_CODE.INPUT_INVALID, `Unsupported format: ${next}`, {
          hint: 'Supported formats: json, text.'
        });
      }
      format = next;
      i += 1;
      continue;
    }

    throw new AppError(ERROR_CODE.INPUT_INVALID, `Unknown option: ${token}`, {
      hint: 'Supported options: --new, --timeout, --max-attempts, --retry-delay-ms, -f/--format.'
    });
  }

  const prompt = positional.join(' ').trim();
  if (!prompt) {
    throw new AppError(ERROR_CODE.INPUT_INVALID, 'Missing prompt', {
      hint: 'Usage: chatgptcli ask "your prompt"'
    });
  }

  return { prompt, format, timeoutSeconds, newChat, maxAttempts, retryDelayMs };
}

function parseDoctorArgs(args) {
  let sessions = false;
  let noLive = false;

  for (const token of args) {
    if (token === '--sessions') {
      sessions = true;
      continue;
    }

    if (token === '--no-live') {
      noLive = true;
      continue;
    }

    throw new AppError(ERROR_CODE.INPUT_INVALID, `Unknown option: ${token}`, {
      hint: 'Supported options: --sessions, --no-live.'
    });
  }

  return { sessions, noLive };
}

function parseSetupArgs(args) {
  if (args.length > 0) {
    throw new AppError(ERROR_CODE.INPUT_INVALID, `Unknown option: ${args[0]}`, {
      hint: 'setup does not take options.'
    });
  }

  return {};
}

function requireValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new AppError(ERROR_CODE.INPUT_INVALID, `Missing value for ${flag}`, {
      hint: `Provide a value after ${flag}.`
    });
  }
  return value;
}

function helpText() {
  return [
    `chatgptcli v${VERSION}`,
    '',
    'Web-backed ChatGPT CLI via the local opencli Browser Bridge.',
    '',
    'Usage:',
    '  chatgptcli ask <prompt> [--new] [--timeout <seconds>] [--max-attempts <n>] [--retry-delay-ms <ms>] [-f json|text]',
    '  chatgptcli doctor [--sessions] [--no-live]',
    '  chatgptcli setup',
    '',
    'Notes:',
    '  ask always uses chatgpt.com web UI, not the OpenAI API.',
    '  ask reuses the site:chatgpt browser session and retries blocked or empty responses with a fresh chat fallback.',
    '  setup validates local prerequisites and prints browser-extension/login guidance.',
    '  Requires the opencli Browser Bridge and a browser profile that has already logged into chatgpt.com at least once.'
  ].join('\n');
}

function writeStdout(message) {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message) {
  process.stderr.write(`${message}\n`);
}
