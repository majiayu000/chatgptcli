import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EXIT_CODE } from '../core/errors.js';
import { OPENCLI_ENV, resolveOpenCliPaths } from '../core/opencli.js';

let runProcess = (cmd, args, options) => spawnSync(cmd, args, options);
let pathExists = (path) => existsSync(path);

export function __setSetupDepsForTest(deps) {
  if (deps.runProcess) {
    runProcess = deps.runProcess;
  }
  if (deps.pathExists) {
    pathExists = deps.pathExists;
  }
}

export function __resetSetupDepsForTest() {
  runProcess = (cmd, args, options) => spawnSync(cmd, args, options);
  pathExists = (path) => existsSync(path);
}

export function runSetup() {
  const bunCheck = checkBun();
  const { root, mainPath, extensionPath, browserIndexPath } = resolveOpenCliPaths();
  const rootExists = pathExists(root);
  const mainExists = pathExists(mainPath);
  const browserExists = pathExists(browserIndexPath);
  const extensionExists = pathExists(extensionPath);

  const allGood = bunCheck.ok && rootExists && mainExists && browserExists && extensionExists;

  const lines = [
    'chatgptcli setup',
    '',
    formatCheck(bunCheck.ok, `Bun available${bunCheck.version ? ` (${bunCheck.version})` : ''}`),
    formatCheck(rootExists, `opencli root resolved: ${root}`),
    formatCheck(mainExists, `opencli built entry: ${mainPath}`),
    formatCheck(browserExists, `opencli browser bridge module: ${browserIndexPath}`),
    formatCheck(extensionExists, `Browser Bridge extension dir: ${extensionPath}`),
    '',
    `Path source: ${OPENCLI_ENV.ROOT}/${OPENCLI_ENV.MAIN} env override or built-in default.`,
    ''
  ];

  lines.push('Actionable next steps:');
  if (!bunCheck.ok) {
    lines.push('- Install Bun and ensure `bun` is on PATH: https://bun.sh');
  }
  if (!rootExists) {
    lines.push(`- Set ${OPENCLI_ENV.ROOT} to your local opencli checkout path.`);
    lines.push('- Or place opencli at `.omx/reference/opencli` under this repo.');
  }
  if (rootExists && (!mainExists || !browserExists)) {
    lines.push(`- Build opencli once: cd "${root}" && bun install`);
  }
  if (!extensionExists) {
    lines.push(`- Ensure Browser Bridge extension exists at "${extensionPath}".`);
  }
  lines.push('- Launch dedicated browser profile: `scripts/launch-chatgpt-browser.sh`.');
  lines.push('- In that browser, complete one-time login at `https://chatgpt.com/`.');
  lines.push(`- Reuse existing Chrome profile option: load unpacked extension from "${extensionPath}".`);
  lines.push('- Verify end-to-end: `bun run src/main.js ask "hello"`.');

  process.stdout.write(`${lines.join('\n')}\n`);
  return allGood ? EXIT_CODE.SUCCESS : EXIT_CODE.CONFIG;
}

function checkBun() {
  const result = runProcess('bun', ['--version'], {
    stdio: 'pipe',
    encoding: 'utf8'
  });

  if (result.error || result.status !== 0) {
    return { ok: false, version: '' };
  }

  return {
    ok: true,
    version: typeof result.stdout === 'string' ? result.stdout.trim() : ''
  };
}

function formatCheck(ok, message) {
  return `${ok ? '[OK]' : '[FAIL]'} ${message}`;
}
