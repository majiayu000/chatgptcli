import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runCli } from '../src/cli.js';
import { __resetAskDepsForTest, __setAskDepsForTest, __test__ as askHelpers } from '../src/commands/ask.js';
import { OPENCLI_ENV, resolveOpenCliPaths, __resetExecRunnerForTest, __setExecRunnerForTest } from '../src/core/opencli.js';
import { __resetSetupDepsForTest, __setSetupDepsForTest } from '../src/commands/setup.js';

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const previousRoot = process.env[OPENCLI_ENV.ROOT];
const previousMain = process.env[OPENCLI_ENV.MAIN];

beforeEach(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  __resetAskDepsForTest();
  __resetExecRunnerForTest();
  __resetSetupDepsForTest();
});

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  __resetAskDepsForTest();
  __resetExecRunnerForTest();
  __resetSetupDepsForTest();
  if (previousRoot === undefined) {
    delete process.env[OPENCLI_ENV.ROOT];
  } else {
    process.env[OPENCLI_ENV.ROOT] = previousRoot;
  }
  if (previousMain === undefined) {
    delete process.env[OPENCLI_ENV.MAIN];
  } else {
    process.env[OPENCLI_ENV.MAIN] = previousMain;
  }
});

function captureStdout() {
  const chunks = [];
  process.stdout.write = (data) => {
    chunks.push(String(data));
    return true;
  };
  return chunks;
}

function captureStderr() {
  const chunks = [];
  process.stderr.write = (data) => {
    chunks.push(String(data));
    return true;
  };
  return chunks;
}

function createFakeOpenCliDist() {
  const root = mkdtempSync(resolve(tmpdir(), 'chatgptcli-opencli-'));
  const distSrc = resolve(root, 'dist', 'src');
  const browserDir = resolve(distSrc, 'browser');
  mkdirSync(browserDir, { recursive: true });
  const mainPath = resolve(distSrc, 'main.js');
  writeFileSync(mainPath, '');
  writeFileSync(resolve(browserDir, 'index.js'), '');
  return { root, mainPath };
}

describe('cli', () => {
  test('ask returns structured success output', async () => {
    __setAskDepsForTest({
      browserAskRunner: async () => ({ response: 'OK' }),
      sleep: async () => {}
    });

    const stdout = captureStdout();
    const code = await runCli(['ask', 'hello world', '--new', '--timeout', '90', '--max-attempts', '3', '-f', 'json']);

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('"ok": true');
    expect(stdout.join('')).toContain('"response": "OK"');
    expect(stdout.join('')).toContain('"mode": "fresh-chat"');
  });

  test('ask retries blocked result and succeeds on second attempt', async () => {
    const calls = [];
    __setAskDepsForTest({
      browserAskRunner: async (input) => {
        calls.push(input);
        if (calls.length === 1) {
          return { response: '[BLOCKED] ChatGPT page is not ready.' };
        }
        return { response: 'final answer' };
      },
      sleep: async () => {}
    });

    const stdout = captureStdout();
    const code = await runCli(['ask', 'hello', '--retry-delay-ms', '0', '-f', 'json']);

    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0].newChat).toBe(false);
    expect(calls[1].newChat).toBe(true);
    expect(stdout.join('')).toContain('"attempts": 2');
    expect(stdout.join('')).toContain('"status": "retry"');
    expect(stdout.join('')).toContain('"status": "success"');
  });

  test('doctor forwards to opencli doctor', async () => {
    const fake = createFakeOpenCliDist();
    process.env[OPENCLI_ENV.MAIN] = fake.mainPath;

    try {
      const calls = [];
      __setExecRunnerForTest((cmd, args) => {
        calls.push({ cmd, args });
        return { status: 0 };
      });

      const code = await runCli(['doctor', '--sessions', '--no-live']);

      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0].args.slice(-3)).toEqual(['doctor', '--sessions', '--no-live']);
      expect(calls[0].args[0]).toBe(fake.mainPath);
    } finally {
      rmSync(fake.root, { recursive: true, force: true });
    }
  });

  test('setup checks prerequisites and prints guidance', async () => {
    __setSetupDepsForTest({
      runProcess: () => ({ status: 0, stdout: '1.3.5' }),
      pathExists: () => true
    });

    const stdout = captureStdout();
    const code = await runCli(['setup']);

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('[OK] Bun available (1.3.5)');
    expect(stdout.join('')).toContain('scripts/launch-chatgpt-browser.sh');
    expect(stdout.join('')).toContain(`${OPENCLI_ENV.MAIN} overrides both the built entry and the sibling browser bridge module`);
  });

  test('setup rejects unknown options', async () => {
    const stderr = captureStderr();
    const code = await runCli(['setup', '--bad']);

    expect(code).toBe(2);
    expect(stderr.join('')).toContain('setup does not take options');
  });

  test('missing prompt returns exit 2', async () => {
    const stderr = captureStderr();
    const code = await runCli(['ask']);

    expect(code).toBe(2);
    expect(stderr.join('')).toContain('INPUT_INVALID');
  });

  test('invalid format returns exit 2', async () => {
    const stderr = captureStderr();
    const code = await runCli(['ask', 'hello', '-f', 'yaml']);

    expect(code).toBe(2);
    expect(stderr.join('')).toContain('Unsupported format');
  });
});

describe('resolveOpenCliPaths', () => {
  test('keeps browserIndexPath under ROOT when MAIN is unset', () => {
    delete process.env[OPENCLI_ENV.MAIN];
    process.env[OPENCLI_ENV.ROOT] = '/tmp/opencli-root';

    const paths = resolveOpenCliPaths();

    expect(paths.mainPath).toBe(resolve('/tmp/opencli-root', 'dist', 'src', 'main.js'));
    expect(paths.browserIndexPath).toBe(resolve('/tmp/opencli-root', 'dist', 'src', 'browser', 'index.js'));
  });

  test('derives browserIndexPath as sibling of MAIN when MAIN is set', () => {
    process.env[OPENCLI_ENV.ROOT] = '/tmp/ignored-root';
    process.env[OPENCLI_ENV.MAIN] = '/custom/dist/src/main.js';

    const paths = resolveOpenCliPaths();

    expect(paths.mainPath).toBe('/custom/dist/src/main.js');
    expect(paths.browserIndexPath).toBe(resolve('/custom/dist/src', 'browser', 'index.js'));
  });
});

describe('ask helpers', () => {
  test('recognizes chatgpt hostnames', async () => {
    const fakePage = (url) => ({ evaluate: () => Promise.resolve(url) });
    expect(await askHelpers.isOnChatGpt(fakePage('https://chatgpt.com/'))).toBe(true);
    expect(await askHelpers.isOnChatGpt(fakePage('https://chat.openai.com/'))).toBe(true);
    expect(await askHelpers.isOnChatGpt(fakePage('https://example.com/'))).toBe(false);
  });

  test('picks latest assistant candidate after the baseline', () => {
    const candidate = askHelpers.pickLatestAssistantCandidate(['older', 'Prompt text', 'Assistant final'], 1, 'Prompt text');
    expect(candidate).toBe('Assistant final');
  });

  test('summarizes the strongest surface issue', () => {
    expect(askHelpers.summarizeSurfaceIssue(askHelpers.normalizeSurfaceState({ challengeLike: true }))).toContain('verification');
    expect(askHelpers.summarizeSurfaceIssue(askHelpers.normalizeSurfaceState({ loginLike: true }))).toContain('logged-in ready state');
    expect(askHelpers.summarizeSurfaceIssue(askHelpers.normalizeSurfaceState({ editorFound: false, sendFound: false }))).toContain('editor');
  });
});
