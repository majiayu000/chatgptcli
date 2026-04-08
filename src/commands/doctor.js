import { runOpenCli } from '../core/opencli.js';

export function runDoctor(options) {
  const args = ['doctor'];

  if (options.sessions) {
    args.push('--sessions');
  }

  if (options.noLive) {
    args.push('--no-live');
  }

  return runOpenCli(args);
}
