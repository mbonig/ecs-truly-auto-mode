#!/usr/bin/env node
/**
 * Verify the two pipeline targets implement the same deployment contract.
 *
 * Supporting two pipelines has one obvious failure mode: they drift, and a fix made
 * in one silently survives in the other. This checks the properties the contract
 * says must match — same image tag source, same build platform, same preflight, same
 * stack deployed with the same parameter — by reading both generated definitions.
 *
 * It compares *behavior-defining* steps, not formatting: caching, log output and
 * notifications are free to differ.
 *
 * Usage: node scripts/verify-pipeline-equivalence.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

const githubWorkflow = readFileSync(
  join(repo, 'templates/pipeline/github-actions/deploy.yml'),
  'utf8',
);
const codepipeline = readFileSync(join(repo, 'templates/cdk/lib/codepipeline.ts'), 'utf8');
const contract = readFileSync(
  join(repo, 'skills/ecs-truly-auto-mode/references/pipeline/contract.md'),
  'utf8',
);

/**
 * Each property must hold in both targets. The matchers are deliberately loose about
 * syntax and strict about substance — the question is whether the step exists and
 * uses the right input, not how it is spelled.
 */
const properties = [
  {
    name: 'image tag comes from the commit SHA',
    github: /github\.sha/,
    codepipeline: /CODEBUILD_RESOLVED_SOURCE_VERSION/,
  },
  {
    name: 'no mutable tag is deployed',
    github: (s) => !/ImageTag=latest|:latest["\s]*$/m.test(s),
    codepipeline: (s) => !/ImageTag=latest/.test(s),
  },
  {
    name: 'build pins the platform to the analyzed architecture',
    github: /--platform \{\{DOCKER_PLATFORM\}\}/,
    codepipeline: /--platform \$\{props\.dockerPlatform\}/,
  },
  {
    name: 'image is pushed to ECR',
    github: /--push|docker push/,
    codepipeline: /docker push/,
  },
  {
    name: 'SSM preflight runs before the deploy',
    github: /ssm-preflight\.sh/,
    codepipeline: /ssm-preflight\.sh/,
  },
  {
    name: 'preflight precedes deploy in step order',
    github: (s) => s.indexOf('ssm-preflight.sh') < s.indexOf('cdk deploy'),
    codepipeline: (s) => s.indexOf('ssm-preflight.sh') < s.indexOf('cdk deploy'),
  },
  {
    name: 'only the service stack is deployed',
    github: /cdk deploy "\$SERVICE_STACK"/,
    codepipeline: /cdk deploy "\$SERVICE_STACK"/,
  },
  {
    name: 'the platform stack is never deployed by the pipeline',
    github: (s) => !/cdk deploy.*-platform/.test(s),
    codepipeline: (s) => !/cdk deploy.*-platform/.test(s),
  },
  {
    name: 'the image tag is passed as a stack parameter',
    github: /--parameters "ImageTag=/,
    codepipeline: /--parameters "ImageTag=/,
  },
  {
    name: 'the deploy waits for a steady state',
    github: /ecs wait services-stable/,
    codepipeline: /ecs wait services-stable/,
  },
  {
    name: 'the trigger is path-filtered',
    github: /paths:/,
    codepipeline: /filePathsIncludes/,
  },
  {
    name: 'no long-lived AWS credentials',
    github: (s) => /id-token: write/.test(s) && !/AWS_SECRET_ACCESS_KEY/.test(s),
    codepipeline: (s) => !/AWS_SECRET_ACCESS_KEY/.test(s),
  },
  {
    name: 'concurrent deploys are serialized',
    github: /concurrency:/,
    codepipeline: /ExecutionMode\.QUEUED/,
  },
];

function holds(matcher, source) {
  return typeof matcher === 'function' ? matcher(source) : matcher.test(source);
}

function main() {
  let failures = 0;

  console.log('Pipeline target equivalence:\n');
  for (const p of properties) {
    const inGithub = holds(p.github, githubWorkflow);
    const inCodePipeline = holds(p.codepipeline, codepipeline);

    if (inGithub && inCodePipeline) {
      console.log(`  ok    ${p.name}`);
    } else {
      failures++;
      const missing = [!inGithub && 'github-actions', !inCodePipeline && 'codepipeline']
        .filter(Boolean)
        .join(', ');
      console.log(`  FAIL  ${p.name}`);
      console.log(`        - not satisfied by: ${missing}`);
    }
  }

  // The contract document is the source of truth; a step present in both targets but
  // absent from the contract means the contract went stale.
  console.log('\nContract documents every required parameter:\n');
  const preflight = readFileSync(join(repo, 'templates/scripts/ssm-preflight.sh'), 'utf8');
  // Read the REQUIRED array and the conditional append, not the whole script.
  const scriptParams = [...preflight.matchAll(/REQUIRED\+?=\(([^)]*)\)/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter((name) => /^[a-z][a-z-]+$/.test(name));
  for (const param of scriptParams) {
    if (contract.includes(param)) {
      console.log(`  ok    ${param}`);
    } else {
      failures++;
      console.log(`  FAIL  ${param} is checked by the preflight but absent from contract.md`);
    }
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nBoth targets satisfy the contract (${properties.length} properties, ${scriptParams.length} parameters).`);
}

main();
