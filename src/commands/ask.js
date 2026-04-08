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
  if (!surface.editorReady || surface.loginLike || surface.challengeLike) {
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
  if (surface.loginLike || surface.challengeLike) {
    return blocked(summarizeSurfaceIssue(surface));
  }

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
      const bodyText = (document.body?.innerText || '').trim().slice(0, 4000);
      return {
        assistants,
        streaming,
        loginLike: ${JSON.stringify(LOGIN_HINTS)}.some((hint) => bodyText.toLowerCase().includes(hint)),
        challengeLike: ${JSON.stringify(CHALLENGE_HINTS)}.some((hint) => bodyText.toLowerCase().includes(hint))
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
      return blocked('ChatGPT page fell back to a login or verification gate while waiting for the response.');
    }
  }

  return { response: lastResponse || NO_RESPONSE_PREFIX };
}

async function probeChatGptSurface(page) {
  const result = await page.evaluate(`(() => {
    const bodyText = (document.body?.innerText || '').trim().slice(0, 4000);
    const normalized = bodyText.toLowerCase();
    const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
    const send = document.querySelector(${JSON.stringify(SEND_SELECTOR)});
    return {
      url: location.href,
      editorFound: editor instanceof HTMLElement,
      sendFound: send instanceof HTMLButtonElement,
      sendDisabled: send instanceof HTMLButtonElement ? send.disabled : false,
      loginLike: ${JSON.stringify(LOGIN_HINTS)}.some((hint) => normalized.includes(hint)),
      challengeLike: ${JSON.stringify(CHALLENGE_HINTS)}.some((hint) => normalized.includes(hint))
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

function normalizeSurfaceState(value) {
  const object = value && typeof value === 'object' ? value : {};
  return {
    url: typeof object.url === 'string' ? object.url : '',
    editorFound: Boolean(object.editorFound),
    sendFound: Boolean(object.sendFound),
    sendDisabled: Boolean(object.sendDisabled),
    editorReady: Boolean(object.editorFound) && Boolean(object.sendFound),
    loginLike: Boolean(object.loginLike),
    challengeLike: Boolean(object.challengeLike)
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
  normalizeSurfaceState,
  summarizeSurfaceIssue,
  isSuccessfulResponse,
  shouldRetry
};
