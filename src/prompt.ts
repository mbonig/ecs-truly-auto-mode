import { createInterface } from 'node:readline';
import { Target, projectTarget, userTarget } from './paths';

export function targetQuestion(): string {
  return (
    'Where should the skills be installed?\n' +
    `  1) ${userTarget().path}  (available in every project) [default]\n` +
    `  2) ${projectTarget().path}  (this project only)\n` +
    'Choose 1 or 2: '
  );
}

/**
 * Turn a prompt answer into a destination.
 *
 * Anything that is not an explicit choice of the project-local option is the
 * default. Pressing enter is by far the most common answer, and it must not be
 * an error or a re-prompt.
 */
export function interpretTargetAnswer(answer: string): Target {
  return answer.trim() === '2' ? projectTarget() : userTarget();
}

export async function promptForTarget(): Promise<Target> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(targetQuestion(), resolve));
    return interpretTargetAnswer(answer);
  } finally {
    rl.close();
  }
}
