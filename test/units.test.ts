import { homedir } from 'node:os';
import { join } from 'node:path';
import { interpretTargetAnswer, targetQuestion } from '../src/prompt';
import { compareVersions, versionStatus } from '../src/version';

describe('version comparison', () => {
  it('orders by numeric field', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });

  it('ignores anything after a prerelease or build marker', () => {
    expect(compareVersions('1.2.3-rc.1', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3+build', '1.2.3')).toBe(0);
  });

  it('treats missing fields as zero', () => {
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('1.1', '1.0.9')).toBe(1);
  });

  it('labels an older install outdated and an unequal one as differing', () => {
    expect(versionStatus('1.0.0', '2.0.0')).toBe('outdated');
    expect(versionStatus('2.0.0', '2.0.0')).toBe('same');
    expect(versionStatus('3.0.0', '2.0.0')).toBe('differs');
    // Equal numerically but not identical: reported as differing rather than
    // ranked, which is the honest answer from a comparison this shallow.
    expect(versionStatus('1.2.3-rc.1', '1.2.3')).toBe('differs');
  });
});

describe('the interactive target prompt', () => {
  it('offers both destinations and marks the default', () => {
    const question = targetQuestion();

    expect(question).toContain(join(homedir(), '.claude', 'skills'));
    expect(question).toContain(join(process.cwd(), '.claude', 'skills'));
    expect(question).toContain('[default]');
  });

  it('takes the user-global default when the answer is empty', () => {
    expect(interpretTargetAnswer('').path).toBe(join(homedir(), '.claude', 'skills'));
    expect(interpretTargetAnswer('  ').path).toBe(join(homedir(), '.claude', 'skills'));
    expect(interpretTargetAnswer('1').path).toBe(join(homedir(), '.claude', 'skills'));
  });

  it('takes the project-local option when the answer is 2', () => {
    expect(interpretTargetAnswer('2').path).toBe(join(process.cwd(), '.claude', 'skills'));
    expect(interpretTargetAnswer(' 2 \n').path).toBe(join(process.cwd(), '.claude', 'skills'));
  });

  it('treats an unrecognized answer as the default rather than an error', () => {
    expect(interpretTargetAnswer('yes').path).toBe(join(homedir(), '.claude', 'skills'));
  });
});
