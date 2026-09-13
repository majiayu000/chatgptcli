import { AppError, ERROR_CODE, EXIT_CODE } from '../core/errors.js';
import { loadBrowserBridge } from '../core/opencli.js';

const CHATGPT_URL = 'https://chatgpt.com/';
const EDITOR_SELECTOR = '.ProseMirror[role="textbox"]';
const SEND_SELECTOR = '[data-testid="send-button"]';
const STOP_SELECTOR = '[data-testid="stop-button"]';
const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
const RETRYABLE_PREFIXES = ['[BLOCKED]', '[NO RESPONSE]', '[SEND FAILED]'];
const BLOCKED_PREFIX = '[BLOCKED]';
const NO_RESPONSE_PREFIX = '[NO RESPONSE]';
const SEND_FAILED_PREFIX = '[SEND FAILED]';
const LOGIN_HINTS = [
  'log in',
  'login',
  'sign in',
  'continue with google',
  '登录',
  '登入'
];
const CHALLENGE_HINTS = [
  'captcha',
  'verify you are human',
  'human verification',
  'access denied',
  'one more step',
  '请先验证',
  '人机验证'
];

// Browser-side probe: classify AUTH via URL / gate controls, never body-wide chat text.
const AUTH_GATE_PROBE_SOURCE = `(() => {
  const LOGIN_HINTS = ${JSON.stringify(LOGIN_HINTS)};
  const CHALLENGE_HINTS = ${JSON.stringify(CHALLENGE_HINTS)};
  const href = String(location.href || '').toLowerCase();
  const pathname = String(location.pathname || '').toLowerCase();

  const authUrl = /\\/(auth|log-?in|sign-?in)(\\/|$|\\?|#)/.test(href)
    || href.includes('accounts.google.com')
    || href.includes('auth.openai.com')
    || href.includes('auth0.com');
  const challengeUrl = pathname.includes('/challenge')
    || href.includes('cf-browser-verification')
    || href.includes('cdn-cgi/challenge');

  const isConversationNode = (node) => Boolean(
    node && node.closest
      && node.closest('[data-message-author-role], .ProseMirror, [data-testid="conversation-turn"]')
  );

  const loginSelectors = [
    '[data-testid="login-button"]',
    '[data-testid="login"]',
    'button[name="login"]',
    'a[href*="/auth"]',
    'a[href*="login"]',
    'a[href*="signin"]'
  ];
  let loginGate = loginSelectors.some((selector) => {
    const node = document.querySelector(selector);
    return Boolean(node) && !isConversationNode(node);
  });

  if (!loginGate) {
    for (const node of document.querySelectorAll('button, a[href], [role="button"]')) {
      if (!(node instanceof HTMLElement) || isConversationNode(node)) continue;
      const text = String(node.innerText || node.textContent || '').trim().toLowerCase();
      if (!text || text.length > 48) continue;
      if (LOGIN_HINTS.some((hint) => text === hint || text.startsWith(hint + ' '))) {
        loginGate = true;
        break;
      }
    }
  }

  const challengeSelectors = [
    'iframe[src*="captcha"]',
    'iframe[src*="challenge"]',
    'iframe[title*="captcha" i]',
    '#challenge-form',
    '.cf-browser-verification',
    '[data-testid*="challenge"]'
  ];
  let challengeGate = challengeSelectors.some((selector) => Boolean(document.querySelector(selector)));

  if (!challengeGate) {
    for (const node of document.querySelectorAll('[role="dialog"], [role="alertdialog"], main form')) {
      if (!(node instanceof HTMLElement) || isConversationNode(node)) continue;
      const text = String(node.innerText || '').toLowerCase().slice(0, 2000);
      if (CHALLENGE_HINTS.some((hint) => text.includes(hint))) {
        challengeGate = true;
        break;
      }
    }
  }

  return {
    authUrl,
    challengeUrl,
    loginGate,
    challengeGate,
    loginLike: Boolean(authUrl || loginGate),
    challengeLike: Boolean(challengeUrl || challengeGate)
  };
})()`;

let browserAskRunner = runBrowserAsk;
let sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function __setAskDepsForTest(deps) {
  if (deps.browserAskRunner) {
    browserAskRunner = deps.browserAskRunner;
  }
  if (deps.sleep) {
    sleepImpl = deps.sleep;
  }
}

export function __resetAskDepsForTest() {
  browserAskRunner = runBrowserAsk;
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runAsk(input) {
  const prompt = (input.prompt || '').trim();
  if (!prompt) {
    throw new AppError(ERROR_CODE.INPUT_INVALID, 'Missing prompt', {
      hint: 'Usage: chatgptcli ask "your prompt"'
    });
  }

  const plan = [];
  let lastResponse = '';

  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    const mode = (input.newChat || attempt > 1) ? 'fresh-chat' : 'current-chat';
    const result = await browserAskRunner({
      prompt,
      timeoutSeconds: input.timeoutSeconds,
      newChat: mode === 'fresh-chat'
    });

    const response = normalizeResponse(result.response);
    lastResponse = response || lastResponse;

    if (isSuccessfulResponse(response)) {
      plan.push({ attempt, mode, status: 'success' });
      return {
        exitCode: EXIT_CODE.SUCCESS,
        output: renderResult({ ok: true, response, attempts: attempt, plan }, input.format)
      };
    }

    const reason = response || 'ChatGPT browser flow returned no response.';
    const retryable = shouldRetry(response);
    plan.push({
      attempt,
      mode,
      status: retryable && attempt < input.maxAttempts ? 'retry' : 'error',
      reason
    });

    if (!retryable || attempt === input.maxAttempts) {
      return {
        exitCode: EXIT_CODE.GENERIC,
        output: renderResult({ ok: false, response: lastResponse || null, attempts: attempt, plan }, input.format)
      };
    }

    await sleepImpl(input.retryDelayMs);
  }

  return {
    exitCode: EXIT_CODE.GENERIC,
    output: renderResult({ ok: false, response: lastResponse || null, attempts: input.maxAttempts, plan }, input.format)
  };
}

async function runBrowserAsk(input) {
  const { BrowserBridge } = await loadBrowserBridge();
  const bridge = new BrowserBridge();

  try {
    const page = await bridge.connect({
      timeout: Math.max(30, input.timeoutSeconds),
      workspace: 'site:chatgpt'
    });

    return await askOnPage(page, {
      prompt: input.prompt,
      timeoutMs: input.timeoutSeconds * 1000,
      newChat: input.newChat
    });
  } finally {
    await bridge.close().catch(() => {});
  }
}

async function askOnPage(page, input) {
  let surface = await ensureReadySurface(page, input.newChat);
  rejectAuthSurface(surface);
  if (!surface.editorReady) {
    return blocked(summarizeSurfaceIssue(surface));
  }

  const baselineAssistants = await getAssistantTexts(page);
  const sendResult = await injectAndSend(page, input.prompt);
  if (!sendResult.ok) {
    return { response: `${SEND_FAILED_PREFIX} ${sendResult.reason}` };
  }

  const result = await waitForAssistantResponse(page, {
    prompt: input.prompt,
    timeoutMs: input.timeoutMs,
    baselineCount: baselineAssistants.length
  });

  if (isSuccessfulResponse(result.response)) {
    return result;
  }

  surface = await probeChatGptSurface(page);
  rejectAuthSurface(surface);

  return result;
}

async function ensureReadySurface(page, newChat) {
  if (newChat || !(await isOnChatGpt(page))) {
    await page.goto(CHATGPT_URL, { settleMs: 1500 });
    await page.wait(2);
  }

  let surface = await waitForSurface(page, 8000);

  if (!surface.editorReady && !surface.loginLike && !surface.challengeLike) {
    await page.goto(CHATGPT_URL, { settleMs: 1500 });
    await page.wait(2);
    surface = await waitForSurface(page, 8000);
  }

  return surface;
}

async function waitForSurface(page, timeoutMs) {
  const startedAt = Date.now();
  let latest = normalizeSurfaceState({});

  while (Date.now() - startedAt < timeoutMs) {
    latest = await probeChatGptSurface(page);
    if (latest.editorReady || latest.loginLike || latest.challengeLike) {
      return latest;
    }
    await page.wait(1);
  }

  return latest;
}

async function getAssistantTexts(page) {
  const result = await page.evaluate(`(() => {
    return Array.from(document.querySelectorAll(${JSON.stringify(ASSISTANT_SELECTOR)}))
      .map((node) => (node instanceof HTMLElement ? node.innerText : node?.textContent || ''))
      .map((text) => (typeof text === 'string' ? text.trim() : ''))
      .filter(Boolean);
  })()`);

  return Array.isArray(result) ? result.map((item) => String(item).trim()).filter(Boolean) : [];
}

async function injectAndSend(page, prompt) {
  const focused = await page.evaluate(`(() => {
    const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
    if (!(editor instanceof HTMLElement)) return { ok: false, reason: 'ChatGPT editor not found.' };
    editor.focus();
    editor.click();
    return { ok: true };
  })()`);

  if (!focused?.ok) {
    return { ok: false, reason: focused?.reason || 'ChatGPT editor not focusable.' };
  }

  if (page.insertText) {
    await page.insertText(prompt);
  } else {
    await page.evaluate(`(() => {
      const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
      if (!(editor instanceof HTMLElement)) return { ok: false };
      document.execCommand('insertText', false, ${JSON.stringify(prompt)});
      return { ok: true };
    })()`);
  }

  await page.wait(1);

  const sendState = await page.evaluate(`(() => {
    const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
    const send = document.querySelector(${JSON.stringify(SEND_SELECTOR)});
    return {
      editorText: editor instanceof HTMLElement ? (editor.innerText || '').trim() : '',
      sendReady: send instanceof HTMLButtonElement ? !send.disabled : false
    };
  })()`);

  if (!sendState?.editorText) {
    return { ok: false, reason: 'Prompt was not inserted into the ChatGPT editor.' };
  }

  if (!sendState.sendReady) {
    return { ok: false, reason: 'ChatGPT send button never became enabled.' };
  }

  const clickResult = await page.evaluate(`(() => {
    const send = document.querySelector(${JSON.stringify(SEND_SELECTOR)});
    if (!(send instanceof HTMLButtonElement)) return { ok: false, reason: 'ChatGPT send button not found.' };
    send.click();
    return { ok: true };
  })()`);

  return clickResult?.ok ? { ok: true } : { ok: false, reason: clickResult?.reason || 'ChatGPT send click failed.' };
}

async function waitForAssistantResponse(page, input) {
  const startedAt = Date.now();
  let lastResponse = '';

  while (Date.now() - startedAt < input.timeoutMs) {
    await page.wait(2);
    const probe = await page.evaluate(`(() => {
      const assistants = Array.from(document.querySelectorAll(${JSON.stringify(ASSISTANT_SELECTOR)}))
        .map((node) => (node instanceof HTMLElement ? node.innerText : node?.textContent || ''))
        .map((text) => (typeof text === 'string' ? text.trim() : ''))
        .filter(Boolean);
      const streaming = Boolean(document.querySelector(${JSON.stringify(STOP_SELECTOR)}));
      const auth = ${AUTH_GATE_PROBE_SOURCE};
      return {
        assistants,
        streaming,
        loginLike: Boolean(auth.loginLike),
        challengeLike: Boolean(auth.challengeLike)
      };
    })()`);

    const response = pickLatestAssistantCandidate(probe.assistants, input.baselineCount, input.prompt);
    if (response) {
      lastResponse = response;
      if (!probe.streaming) {
        return { response };
      }
    }

    if (probe.loginLike || probe.challengeLike) {
      rejectAuthSurface(probe);
    }
  }

  return { response: lastResponse || NO_RESPONSE_PREFIX };
}

async function probeChatGptSurface(page) {
  const result = await page.evaluate(`(() => {
    const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
    const send = document.querySelector(${JSON.stringify(SEND_SELECTOR)});
    const auth = ${AUTH_GATE_PROBE_SOURCE};
    return {
      url: location.href,
      editorFound: editor instanceof HTMLElement,
      sendFound: send instanceof HTMLButtonElement,
      sendDisabled: send instanceof HTMLButtonElement ? send.disabled : false,
      loginLike: Boolean(auth.loginLike),
      challengeLike: Boolean(auth.challengeLike)
    };
  })()`);

  return normalizeSurfaceState(result);
}

async function isOnChatGpt(page) {
  const url = await page.evaluate('window.location.href').catch(() => '');
  if (typeof url !== 'string' || !url) return false;

  try {
    const hostname = new URL(url).hostname;
    return hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com') || hostname === 'chat.openai.com';
  } catch {
    return false;
  }
}

function blocked(message) {
  return { response: `${BLOCKED_PREFIX} ${message}` };
}

function rejectAuthSurface(surface) {
  if (surface.challengeLike) {
    throw new AppError(ERROR_CODE.AUTH_INVALID, summarizeSurfaceIssue(surface), {
      hint: 'Complete the ChatGPT verification challenge in the browser profile, then retry.'
    });
  }

  if (surface.loginLike) {
    throw new AppError(ERROR_CODE.AUTH_MISSING, summarizeSurfaceIssue(surface), {
      hint: 'Log into chatgpt.com in the browser profile used by the bridge, then retry.'
    });
  }
}

function normalizeResponse(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pickLatestAssistantCandidate(assistants, baselineCount, prompt) {
  const normalizedPrompt = normalizeResponse(prompt);
  const fresh = assistants.slice(Math.max(0, baselineCount)).map(normalizeResponse).filter(Boolean);

  for (let i = fresh.length - 1; i >= 0; i -= 1) {
    if (fresh[i] !== normalizedPrompt) {
      return fresh[i];
    }
  }

  return '';
}

function classifyAuthGateSignals(signals) {
  const object = signals && typeof signals === 'object' ? signals : {};
  return {
    loginLike: Boolean(object.authUrl || object.loginGate || object.loginLike),
    challengeLike: Boolean(object.challengeUrl || object.challengeGate || object.challengeLike)
  };
}

function normalizeSurfaceState(value) {
  const object = value && typeof value === 'object' ? value : {};
  const auth = classifyAuthGateSignals(object);
  return {
    url: typeof object.url === 'string' ? object.url : '',
    editorFound: Boolean(object.editorFound),
    sendFound: Boolean(object.sendFound),
    sendDisabled: Boolean(object.sendDisabled),
    editorReady: Boolean(object.editorFound) && Boolean(object.sendFound),
    loginLike: auth.loginLike,
    challengeLike: auth.challengeLike
  };
}

function summarizeSurfaceIssue(state) {
  if (state.challengeLike) {
    return 'ChatGPT page is blocked by a verification or access challenge.';
  }
  if (state.loginLike) {
    return 'ChatGPT page is not in a logged-in ready state.';
  }
  if (!state.editorFound) {
    return 'ChatGPT composer editor was not found.';
  }
  if (!state.sendFound) {
    return 'ChatGPT send button was not found.';
  }
  return 'ChatGPT composer never reached a ready state.';
}

function isSuccessfulResponse(response) {
  return Boolean(response) && !RETRYABLE_PREFIXES.some((prefix) => response.startsWith(prefix));
}

function shouldRetry(response) {
  return RETRYABLE_PREFIXES.some((prefix) => response.startsWith(prefix));
}

function renderResult(result, format) {
  if (format === 'text') {
    if (result.ok) return result.response;

    const lastStep = result.plan[result.plan.length - 1];
    return [
      'Failed to get a stable ChatGPT response.',
      result.response ? `Last response: ${result.response}` : '',
      lastStep?.reason ? `Last reason: ${lastStep.reason}` : ''
    ].filter(Boolean).join('\n');
  }

  return JSON.stringify(result, null, 2);
}

export const __test__ = {
  isOnChatGpt,
  pickLatestAssistantCandidate,
  classifyAuthGateSignals,
  normalizeSurfaceState,
  summarizeSurfaceIssue,
  rejectAuthSurface,
  isSuccessfulResponse,
  shouldRetry,
  AUTH_GATE_PROBE_SOURCE
};
