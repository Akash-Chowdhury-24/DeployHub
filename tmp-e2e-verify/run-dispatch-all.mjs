/**
 * Extra: workflow_dispatch deploy --env all on config #3 project,
 * plus divergent-history rollback proof.
 */
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { deployToAll } from '../src/deployment/index.js';
import { resolveEnvTargets } from '../src/core/environments.js';
import {
  rollbackToVersion,
  formatRollbackAllSummary,
} from '../src/utils/rollback/engine.js';
import { createArtifact } from '../src/artifact/engine.js';
import { uploadToAll } from '../src/storage/index.js';
import { resolveBuildId } from '../src/utils/build-id.js';
import { loadEnvArtifactHistory } from '../src/storage/index.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SIM = path.join(ROOT, 'sim', 'mixed-trigger');

const config = await fs.readJson(path.join(SIM, 'deployhub.config.json'));
process.env.GITHUB_ACTIONS = 'true';
process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
process.env.SSH_KEY = '-----BEGIN FAKE-----\nk\n-----END FAKE-----\n';
process.env.PRODUCTION_SSH_KEY = process.env.SSH_KEY;

function banner(t) {
  console.log('\n' + '='.repeat(72) + '\n' + t + '\n' + '='.repeat(72));
}

banner('4) workflow_dispatch deploy --env all');
const { targets } = resolveEnvTargets(config, 'all');
console.log(`[decision] resolveEnvTargets(--env all) => ${JSON.stringify(targets)}`);

const prev = process.cwd();
process.chdir(SIM);
try {
  const projectRoot = path.join(SIM, 'artifact', config.project);
  const dates = (await fs.readdir(projectRoot)).sort().reverse();
  const builds = (await fs.readdir(path.join(projectRoot, dates[0]))).sort().reverse();
  const artifactDir = path.join(projectRoot, dates[0], builds[0]);
  console.log(`[artifact] ${artifactDir}`);
  const deployed = await deployToAll(config, artifactDir, targets);
  console.log(`[deploy] deployToAll(--env all) => ${JSON.stringify(deployed)}`);
} finally {
  process.chdir(prev);
}

banner('5) Divergent histories: deploy ONLY production with a new build, then rollback --env all');
process.chdir(SIM);
try {
  config.version = '1.0.2';
  const { buildId } = resolveBuildId({ semver: '1.0.2' });
  config.buildId = buildId;
  await fs.writeFile(path.join(SIM, 'dist', 'index.html'), '<html>v102</html>');
  const result = await createArtifact(config, [], SIM);
  await uploadToAll(config.storage, result.zipPath, config);
  await deployToAll(config, result.artifactDir, ['production']); // ONLY production
  console.log(`[seed] production-only deploy buildId=${buildId}`);

  const devH = await loadEnvArtifactHistory(['local'], config.project, 'development', {
    allowLegacyFallback: false,
  });
  const prodH = await loadEnvArtifactHistory(['local'], config.project, 'production', {
    allowLegacyFallback: false,
  });
  console.log('[history] development head:', JSON.stringify(devH.entries[0]));
  console.log('[history] production head:', JSON.stringify(prodH.entries[0]));
  console.log(
    `[isolation] heads differ? ${devH.entries[0].buildId !== prodH.entries[0].buildId}`
  );

  const { results, failures } = await rollbackToVersion(config, undefined, SIM, {
    envNames: ['development', 'production'],
    continueOnError: true,
  });
  console.log('[rollback results]');
  for (const r of results) {
    console.log(`  ${r.envName} -> ${r.entry.buildId}`);
  }
  console.log(formatRollbackAllSummary(results, failures, []));
  const byEnv = Object.fromEntries(results.map((r) => [r.envName, r.entry.buildId]));
  if (byEnv.development === byEnv.production) {
    console.log(
      '[note] previous builds happen to match (both had same prior); heads before rollback differed — see above'
    );
  }
  // Critical: each env must roll back to ITS previous, which for production is 1.0.1
  // and for development is also 1.0.1 (dev never got 1.0.2). After prod-only 1.0.2,
  // rolling back production goes to 1.0.1; development previous is 1.0.0 (if 1.0.1 is current).
  // Wait: after seed, development head is still 1.0.1, so previous = 1.0.0
  // production head is 1.0.2, previous = 1.0.1
  console.log('[expect] development previous=1.0.0-*, production previous=1.0.1-*');
  if (!String(byEnv.development).startsWith('1.0.0')) {
    throw new Error(`development should roll to 1.0.0-*, got ${byEnv.development}`);
  }
  if (!String(byEnv.production).startsWith('1.0.1')) {
    throw new Error(`production should roll to 1.0.1-*, got ${byEnv.production}`);
  }
  console.log('[ok] divergent histories — no cross-contamination');
} finally {
  process.chdir(prev);
}
