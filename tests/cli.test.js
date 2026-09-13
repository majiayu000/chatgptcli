import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { __resetAskDepsForTest, __setAskDepsForTest, __test__ as askHelpers } from '../src/commands/ask.js';
import { __resetExecRunnerForTest, __setExecRunnerForTest, OPENCLI_ENV } from '../src/core/opencli.js';
import { __resetSetupDepsForTest, __setSetupDepsForTest } from '../src/commands/setup.js';

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalOpenCliRoot = process.env[OPENCLI_ENV.ROOT];
const originalOpenCliMain = process.env[OPENCLI_ENV.MAIN];

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
  if (originalOpenCliRoot === undefined) {
    delete process.env[OPENCLI_ENV.ROOT];
  } else {
    process.env[OPENCLI_ENV.ROOT] = originalOpenCliRoot;
  }
  if (originalOpenCliMain === undefined) {
    delete process.env[OPENCLI_ENV.MAIN];
  } else {
    process.env[OPENCLI_ENV.MAIN] = originalOpenCliMain;
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

function makeOpenCliFixture({ withArtifacts = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'chatgptcli-opencli-'));
  if (withArtifacts) {
    const distSrc = join(root, 'dist', 'src');
    const browserDir = join(distSrc, 'browser');
    mkdirSync(browserDir, { recursive: true });
    writeFileSync(join(distSrc, 'main.js'), 'export {};\n');
    writeFileSync(join(browserDir, 'index.js'), 'export class BrowserBridge {}\n');
  }
  return root;
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
    const root = makeOpenCliFixture({ withArtifacts: true });
    process.env[OPENCLI_ENV.ROOT] = root;

    const calls = [];
    __setExecRunnerForTest((cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0 };
    });

    try {
      const code = await runCli(['doctor', '--sessions', '--no-live']);

      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0].args.slice(-3)).toEqual(['doctor', '--sessions', '--no-live']);
      expect(calls[0].args).not.toContain('install');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('doctor fails with setup hint when opencli artifacts are missing (never auto-installs)', async () => {
    const root = makeOpenCliFixture({ withArtifacts: false });
    process.env[OPENCLI_ENV.ROOT] = root;

    const calls = [];
    __setExecRunnerForTest((cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0 };
    });

    const stderr = captureStderr();
    try {
      const code = await runCli(['doctor']);

      expect(code).toBe(6);
      expect(calls).toHaveLength(0);
      expect(stderr.join('')).toContain('CONFIG_INVALID');
      expect(stderr.join('')).toContain('build artifacts missing');
      expect(stderr.join('')).toContain('bun install');
      expect(stderr.join('')).toContain('never auto-install');
    } finally {
      rmSync(root, { recursive: true, force: true });
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
