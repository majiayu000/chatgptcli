import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runCli } from '../src/cli.js';
import { __resetAskDepsForTest, __setAskDepsForTest, __test__ as askHelpers } from '../src/commands/ask.js';
import { __resetExecRunnerForTest, __setExecRunnerForTest } from '../src/core/opencli.js';
import { __resetSetupDepsForTest, __setSetupDepsForTest } from '../src/commands/setup.js';
import { AppError, ERROR_CODE } from '../src/core/errors.js';

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

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
    const calls = [];
    __setExecRunnerForTest((cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0 };
    });

    const code = await runCli(['doctor', '--sessions', '--no-live']);

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(-3)).toEqual(['doctor', '--sessions', '--no-live']);
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

  test('login surface exits with AUTH (3) and AUTH_MISSING', async () => {
    let calls = 0;
    __setAskDepsForTest({
      browserAskRunner: async () => {
        calls += 1;
        throw new AppError(ERROR_CODE.AUTH_MISSING, 'ChatGPT page is not in a logged-in ready state.');
      },
      sleep: async () => {}
    });

    const stderr = captureStderr();
    const code = await runCli(['ask', 'hello', '--max-attempts', '3', '--retry-delay-ms', '0']);

    expect(code).toBe(3);
    expect(calls).toBe(1);
    expect(stderr.join('')).toContain('AUTH_MISSING');
  });

  test('challenge surface exits with AUTH (3) and AUTH_INVALID', async () => {
    let calls = 0;
    __setAskDepsForTest({
      browserAskRunner: async () => {
        calls += 1;
        throw new AppError(ERROR_CODE.AUTH_INVALID, 'ChatGPT page is blocked by a verification or access challenge.');
      },
      sleep: async () => {}
    });

    const stderr = captureStderr();
    const code = await runCli(['ask', 'hello', '--max-attempts', '3', '--retry-delay-ms', '0']);

    expect(code).toBe(3);
    expect(calls).toBe(1);
    expect(stderr.join('')).toContain('AUTH_INVALID');
  });

  test('non-auth blocked editor still exits GENERIC (1) and retries', async () => {
    const calls = [];
    __setAskDepsForTest({
      browserAskRunner: async (input) => {
        calls.push(input);
        return { response: '[BLOCKED] ChatGPT composer editor was not found.' };
      },
      sleep: async () => {}
    });

    const stdout = captureStdout();
    const code = await runCli(['ask', 'hello', '--max-attempts', '2', '--retry-delay-ms', '0', '-f', 'json']);

    expect(code).toBe(1);
    expect(calls).toHaveLength(2);
    expect(stdout.join('')).toContain('[BLOCKED]');
    expect(stdout.join('')).toContain('"status": "retry"');
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

  test('rejectAuthSurface throws AUTH_MISSING for login and AUTH_INVALID for challenge', () => {
    try {
      askHelpers.rejectAuthSurface(askHelpers.normalizeSurfaceState({ loginLike: true }));
      throw new Error('expected AUTH_MISSING');
    } catch (error) {
      expect(error.code).toBe(ERROR_CODE.AUTH_MISSING);
    }

    try {
      askHelpers.rejectAuthSurface(askHelpers.normalizeSurfaceState({ challengeLike: true, loginLike: true }));
      throw new Error('expected AUTH_INVALID');
    } catch (error) {
      expect(error.code).toBe(ERROR_CODE.AUTH_INVALID);
    }

    expect(() => askHelpers.rejectAuthSurface(askHelpers.normalizeSurfaceState({ editorFound: false }))).not.toThrow();
  });

  test('AUTH classification requires gate URL or control, not conversational body text', () => {
    // Conversational "How do I log in?" must not become AUTH just because the words appear.
    expect(askHelpers.classifyAuthGateSignals({
      authUrl: false,
      loginGate: false,
      challengeUrl: false,
      challengeGate: false
    })).toEqual({ loginLike: false, challengeLike: false });

    expect(askHelpers.classifyAuthGateSignals({ authUrl: true })).toEqual({
      loginLike: true,
      challengeLike: false
    });
    expect(askHelpers.classifyAuthGateSignals({ loginGate: true })).toEqual({
      loginLike: true,
      challengeLike: false
    });
    expect(askHelpers.classifyAuthGateSignals({ challengeGate: true })).toEqual({
      loginLike: false,
      challengeLike: true
    });

    const probeSource = askHelpers.AUTH_GATE_PROBE_SOURCE;
    expect(probeSource).not.toContain('document.body');
    expect(probeSource).not.toContain('innerText || \'\').trim().slice(0, 4000)');
    expect(probeSource).toContain('data-message-author-role');
    expect(probeSource).toContain('login-button');
  });

  test('AUTH probe excludes sidebar/history login-text matches and covers static interstitials', () => {
    const probeSource = askHelpers.AUTH_GATE_PROBE_SOURCE;
    // Login-hint fallback must not scan bare document-wide anchors (sidebar false positives).
    expect(probeSource).toContain('isNavOrHistoryNode');
    expect(probeSource).toContain('a[href^="/c/"]');
    expect(probeSource).toContain('loginTextRoots');
    expect(probeSource).not.toContain("document.querySelectorAll('button, a[href], [role=\"button\"]')");
    expect(probeSource).not.toContain('document.querySelectorAll(\'button, a[href], [role="button"]\')');
    // Static access-denied pages outside dialog/main form need interstitial roots when chat chrome is absent.
    expect(probeSource).toContain('hasChatChrome');
    expect(probeSource).toContain('.cf-error-details');
    expect(probeSource).toContain('[data-testid="error-message"]');
    expect(probeSource).toContain("challengeRootSelector");
  });

  test('AUTH probe avoids composer-form challenge FPs, bare error-message proof, nav CTA misses, and logout /auth matches', () => {
    const probeSource = askHelpers.AUTH_GATE_PROBE_SOURCE;
    // Composer main form with the editor must not be treated as a challenge root.
    expect(probeSource).toContain('formContainsComposer');
    expect(probeSource).toContain('.ProseMirror[role="textbox"], [data-testid="send-button"]');
    // Generic error-message is a hint root, not automatic challenge proof.
    expect(probeSource).toContain('Proven challenge widgets only');
    expect(probeSource).not.toMatch(/challengeSelectors = \[[^\]]*error-message/s);
    // Top-level nav login CTAs must still count; only sidebar/history is excluded.
    expect(probeSource).toContain('isExplicitLoginControl');
    expect(probeSource).toContain('top-level homepage <nav>/<aside> login CTAs must still count');
    expect(probeSource).not.toMatch(/isNavOrHistoryNode = \(node\) => Boolean\(\s*node && node\.closest && node\.closest\(\[\s*'nav',\s*'aside'/);
    // Logout/signout hrefs must not count as login gates via /auth.
    expect(probeSource).toContain('isLogoutOrSignoutHref');
    expect(probeSource).toContain('logoutUrl');
    expect(probeSource).toContain('isLoginAuthHref');
  });
});
