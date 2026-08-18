#!/usr/bin/env node
/**
 * Validate an ecs-auto-mode manifest.
 *
 * Two layers run here. The JSON Schema covers shape and field-level rules. The
 * consistency checks below cover the cross-field invariants the skill depends on
 * but that JSON Schema expresses poorly — mostly "this finding implies that plan
 * entry", which is where a hand-edited manifest actually goes wrong.
 *
 * Usage: node scripts/validate-manifest.mjs <path-to-manifest.yaml> [...]
 * Exits non-zero if any manifest fails.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import Ajv from 'ajv';
import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, '..', 'schemas', 'manifest.schema.json');

/**
 * What the skill owns under `infra.style: projen`, relative to the infra project.
 * An allowlist rather than a list of projen's outputs, because projen's output set
 * grows with its versions — `test/tsconfig.json` and `projenrc/tsconfig.json` are
 * both in there — and a denylist would quietly stop covering the new ones.
 */
const PROJEN_OWNED = ['.projenrc.ts', 'src/', 'scripts/'];

/** Named for the message only: recording one of these is the interesting mistake. */
const PROJEN_DERIVED = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.dev.json',
  'cdk.json', '.gitignore', '.gitattributes', '.npmignore', '.projen',
  'test/tsconfig.json', 'projenrc/tsconfig.json',
];

/** Cross-field invariants. Each returns an array of human-readable problems. */
const consistencyChecks = [
  function planApprovalRequiresValidatedBuild(m) {
    if (m.plan?.approved && m.analysis?.buildValidated !== true) {
      return ['plan.approved is true but analysis.buildValidated is not — the plan cannot be approved for an image that has not been proven to build'];
    }
    return [];
  },

  function egressClassificationMatchesEvidence(m) {
    const problems = [];
    const classification = m.analysis?.egress?.classification?.value;
    const hosts = m.analysis?.egress?.externalHosts ?? [];
    if (classification === 'none' && hosts.length > 0) {
      problems.push(`egress.classification is "none" but ${hosts.length} externalHosts are recorded — a host that leaves the VPC forces "public"`);
    }
    if (classification === 'public' && hosts.length === 0) {
      problems.push('egress.classification is "public" but no externalHosts are recorded — the plan must name the call that forced NAT');
    }
    return problems;
  },

  function natPlanMatchesEgress(m) {
    const classification = m.analysis?.egress?.classification?.value;
    const nat = findResource(m, 'nat-gateway');
    if (!nat) return [];
    if (classification === 'none' && nat.action !== 'skip') {
      return [`egress.classification is "none" but plan resource "nat-gateway" is "${nat.action}" — an isolated workload should not pay for a NAT gateway`];
    }
    if (classification === 'public' && nat.action === 'skip') {
      return ['egress.classification is "public" but plan resource "nat-gateway" is "skip" — the workload would be unable to reach its external dependencies'];
    }
    return [];
  },

  function healthCheckPathMatchesType(m) {
    const hc = m.analysis?.container?.healthCheck;
    if (!hc) return [];
    const type = hc.type?.value;
    if (type === 'http' && !hc.path) {
      return ['container.healthCheck.type is "http" but no path is recorded'];
    }
    if (type === 'tcp' && hc.path) {
      return ['container.healthCheck.type is "tcp" but a path is recorded — the path would be ignored'];
    }
    return [];
  },

  function adoptedResourcesCarryIdentifiers(m) {
    // The schema enforces that `identifiers` exists; this catches empty-string values,
    // which is what a half-finished interactive session actually leaves behind.
    const problems = [];
    for (const r of m.plan?.resources ?? []) {
      if (r.action !== 'adopt') continue;
      for (const [key, value] of Object.entries(r.identifiers ?? {})) {
        const empty = value === '' || value === null ||
          (Array.isArray(value) && (value.length === 0 || value.some((v) => !v)));
        if (empty) {
          problems.push(`plan resource "${r.id}" is adopted but identifier "${key}" is empty`);
        }
      }
    }
    return problems;
  },

  function createdResourcesCarryNoIdentifiers(m) {
    const problems = [];
    for (const r of m.plan?.resources ?? []) {
      if (r.action === 'adopt') continue;
      if (r.identifiers) {
        problems.push(`plan resource "${r.id}" is "${r.action}" but carries identifiers [${Object.keys(r.identifiers).join(', ')}] — only an adopted resource is imported, so these would be silently ignored`);
      }
    }
    return problems;
  },

  function approvedPlanHasNoUnconfirmedFindings(m) {
    if (!m.plan?.approved) return [];
    const problems = [];
    for (const { path, finding } of walkFindings(m.analysis)) {
      if (finding.confidence === 'high') continue;
      if (finding.confirmedByUser) continue;
      problems.push(`plan is approved but ${path} is "${finding.confidence}" confidence and unconfirmed — anything below high confidence must be asked about, not defaulted`);
    }
    return problems;
  },

  function conflictFindingsCarryAlternatives(m) {
    const problems = [];
    for (const { path, finding } of walkFindings(m.analysis)) {
      if (finding.confidence !== 'conflict') continue;
      if (!finding.alternatives?.length) {
        problems.push(`${path} is a conflict but records no alternatives — the user cannot choose between values they cannot see`);
      }
    }
    return problems;
  },

  function adoptedVpcCarriesSubnets(m) {
    const vpc = findResource(m, 'vpc');
    if (vpc?.action !== 'adopt') return [];
    const ids = vpc.identifiers ?? {};
    const problems = [];
    if (!ids.availabilityZones?.length) {
      problems.push('adopted vpc records no availabilityZones — required so that synth needs no environment lookup');
    }
    const hasSubnets = ['isolatedSubnetIds', 'privateSubnetIds', 'publicSubnetIds']
      .some((k) => ids[k]?.length);
    if (!hasSubnets) {
      problems.push('adopted vpc records no subnet IDs — required so that synth needs no environment lookup');
    }
    return problems;
  },

  function githubActionsRecordsAnOidcProviderDecision(m) {
    if (m.pipeline?.target !== 'github-actions') return [];
    const provider = findResource(m, 'github-oidc-provider');
    if (!provider || provider.action === 'skip') {
      return ['pipeline.target is "github-actions" but plan resource "github-oidc-provider" is missing or skipped — the generated role creates a provider when it is handed none, and most accounts already have one, so an undecided entry is a first deploy that fails with EntityAlreadyExists'];
    }
    if (provider.action === 'adopt' && !provider.identifiers?.providerArn) {
      return ['plan resource "github-oidc-provider" is adopted but records no providerArn'];
    }
    return [];
  },

  function publicHostnameCarriesZoneAndCertificate(m) {
    const dns = findResource(m, 'dns-record');
    if (!dns || dns.action === 'skip') return [];

    const problems = [];
    const zone = findResource(m, 'hosted-zone');
    if (zone?.action !== 'adopt') {
      problems.push(`plan resource "dns-record" is "${dns.action}" but "hosted-zone" is ${zone ? `"${zone.action}"` : 'missing'} — a public hostname needs an adopted zone to hold the record, and the skill does not create hosted zones`);
    }

    const cert = findResource(m, 'certificate');
    if (!cert || cert.action === 'skip') {
      problems.push(`plan resource "dns-record" is "${dns.action}" but "certificate" is ${cert ? `"${cert.action}"` : 'missing'} — serving the hostname over HTTPS needs a certificate created or adopted`);
    } else if (cert.action === 'create' && zone?.action !== 'adopt') {
      problems.push('plan resource "certificate" is "create" but no hosted zone is adopted — a created certificate is DNS-validated, and the validation record has to go somewhere');
    }

    return problems;
  },

  function createdCertificateIsCoveredByTheAdoptedZone(m) {
    const cert = findResource(m, 'certificate');
    if (cert?.action !== 'create') return [];
    const zoneName = findResource(m, 'hosted-zone')?.identifiers?.zoneName;
    const hostname = m.analysis?.hostnames?.public?.[0]?.value;
    if (!zoneName || !hostname) return [];

    // A certificate validated against a zone that is not authoritative for the name
    // never issues, and CloudFormation waits on it until the stack times out rather
    // than failing — so this is worth catching in the manifest.
    if (hostname !== zoneName && !hostname.endsWith(`.${zoneName}`)) {
      return [`plan resource "certificate" is "create" for "${hostname}", but the adopted hosted zone is "${zoneName}" — DNS validation writes its record into that zone, so the certificate would never issue and the platform stack would block until it timed out`];
    }
    return [];
  },

  function pipelineFilterCoversBuildContext(m) {
    const contextPaths = m.analysis?.buildContextPaths ?? [];
    const filter = m.pipeline?.pathFilter ?? [];
    const missing = contextPaths.filter((p) => !filter.includes(p));
    if (missing.length) {
      return [`pipeline.pathFilter omits build-context paths [${missing.join(', ')}] — changes there would silently not deploy`];
    }
    return [];
  },

  function generatedRecordsMatchProjectStyle(m) {
    // An absent `infra` section means the plain style — see references/manifest-schema.md.
    const style = m.infra?.style ?? 'plain';
    const problems = [];

    for (const g of m.generated ?? []) {
      if (!g.path?.startsWith('infra/')) continue;
      const withinInfra = g.path.slice('infra/'.length);

      if (style === 'projen') {
        const owned = PROJEN_OWNED.some((p) => withinInfra === p || withinInfra.startsWith(p));
        if (owned) continue;

        if (PROJEN_DERIVED.some((p) => withinInfra === p || withinInfra.startsWith(`${p}/`))) {
          problems.push(`generated records "${g.path}", which projen derives from .projenrc.ts — recording a hash for it makes every "npx projen" run look like a user edit`);
        } else if (withinInfra.startsWith('lib/') || withinInfra.startsWith('bin/')) {
          problems.push(`generated records "${g.path}" but infra.style is "projen", which keeps its sources under src/`);
        } else {
          problems.push(`generated records "${g.path}", which the skill does not own under the projen style — it owns ${PROJEN_OWNED.join(', ')} only`);
        }
      } else if (withinInfra.startsWith('src/') || withinInfra === '.projenrc.ts') {
        problems.push(`generated records "${g.path}" but infra.style is "plain", which keeps its sources under bin/ and lib/`);
      }
    }

    return problems;
  },

  function pipelineFilterMatchesProjectStyle(m) {
    const style = m.infra?.style ?? 'plain';
    const filter = m.pipeline?.pathFilter ?? [];
    const problems = [];

    // The service stack source has to be in the filter: changing what gets deployed
    // must trigger a deploy. Its path follows the layout the style dictates.
    const serviceStack = style === 'projen'
      ? 'infra/src/service-stack.ts'
      : 'infra/lib/service-stack.ts';
    if (!filter.includes(serviceStack)) {
      problems.push(`pipeline.pathFilter omits "${serviceStack}" — a change to the service stack would silently not deploy`);
    }

    // .projenrc.ts pins the CDK version the service stack is synthesized with.
    if (style === 'projen' && !filter.includes('infra/.projenrc.ts')) {
      problems.push('pipeline.pathFilter omits "infra/.projenrc.ts" — it pins the CDK version the service stack is synthesized with');
    }

    // The platform stack is deliberately absent: this pipeline does not deploy it,
    // and a trigger that runs a pipeline which ignores the change is worse than none.
    const platformStack = style === 'projen'
      ? 'infra/src/platform-stack.ts'
      : 'infra/lib/platform-stack.ts';
    if (filter.includes(platformStack)) {
      problems.push(`pipeline.pathFilter includes "${platformStack}", but this pipeline does not deploy the platform stack — the run would report success while ignoring the change`);
    }

    return problems;
  },

  function generatedRecordsAreUnique(m) {
    const seen = new Set();
    const problems = [];
    for (const g of m.generated ?? []) {
      if (seen.has(g.path)) problems.push(`generated records "${g.path}" more than once`);
      seen.add(g.path);
    }
    return problems;
  },
];

function findResource(manifest, id) {
  return (manifest.plan?.resources ?? []).find((r) => r.id === id);
}

/** Yield every finding-shaped object in the analysis tree, with a dotted path. */
function* walkFindings(node, path = 'analysis') {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* walkFindings(item, `${path}[${i}]`);
    return;
  }
  if ('confidence' in node && 'evidence' in node) {
    yield { path, finding: node };
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    yield* walkFindings(value, `${path}.${key}`);
  }
}

function validate(manifestPath, validateSchema) {
  const problems = [];
  let manifest;

  try {
    manifest = parseYaml(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return [`could not read or parse: ${err.message}`];
  }

  if (!validateSchema(manifest)) {
    for (const err of validateSchema.errors) {
      const at = err.instancePath || '(root)';
      problems.push(`${at} ${err.message}`);
    }
    // Consistency checks assume a well-shaped document; running them on a
    // schema-invalid manifest produces noise that buries the real error.
    return problems;
  }

  for (const check of consistencyChecks) {
    problems.push(...check(manifest));
  }
  return problems;
}

function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error('usage: validate-manifest.mjs <manifest.yaml> [...]');
    process.exit(2);
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateSchema = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));

  let failed = 0;
  for (const path of paths) {
    const problems = validate(path, validateSchema);
    const label = relative(process.cwd(), path);
    if (problems.length === 0) {
      console.log(`  ok    ${label}`);
    } else {
      failed++;
      console.log(`  FAIL  ${label}`);
      for (const p of problems) console.log(`        - ${p}`);
    }
  }

  if (failed > 0) {
    console.log(`\n${failed} of ${paths.length} manifest(s) failed validation.`);
    process.exit(1);
  }
  console.log(`\n${paths.length} manifest(s) valid.`);
}

main();
