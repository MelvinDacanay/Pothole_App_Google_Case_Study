import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Credential selection is intentionally independent of NODE_ENV: development hosts
// can run a production build, while Cloud Run must always use its attached identity.
export function credentialMode(env: NodeJS.ProcessEnv): 'adc' | 'service_account' | 'unconfigured' {
  if (env.K_SERVICE || env.CLOUD_RUN_JOB) {
    for (const name of ['FIREBASE_SERVICE_ACCOUNT_JSON', 'GOOGLE_APPLICATION_CREDENTIALS', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'GCE_METADATA_HOST', 'GCE_METADATA_IP', 'GCE_METADATA_ROOT']) {
      if (env[name]) throw new Error(`Cloud Run rejects credential or emulator override: ${name}`);
    }
    return 'adc';
  }
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) return 'service_account';
  if (env.GOOGLE_APPLICATION_CREDENTIALS || env.FIRESTORE_EMULATOR_HOST || env.PATCHUP_USE_ADC === 'true') return 'adc';
  return 'unconfigured';
}

// Cloud Run ADC must use the provisioned runtime identity, not a developer's
// well-known ADC file or a default compute service account with different roles.
export async function verifyCloudRunIdentity(projectId: string, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<void> {
  if (!env.K_SERVICE && !env.CLOUD_RUN_JOB) return;
  credentialMode(env);
  const home = env.HOME || homedir();
  const paths = [join(home, '.config', 'gcloud', 'application_default_credentials.json')];
  if (env.CLOUDSDK_CONFIG) paths.push(join(env.CLOUDSDK_CONFIG, 'application_default_credentials.json'));
  if (env.XDG_CONFIG_HOME) paths.push(join(env.XDG_CONFIG_HOME, 'gcloud', 'application_default_credentials.json'));
  if (paths.some(file => existsSync(file))) throw new Error('Cloud Run rejects local ADC files.');
  const response = await fetcher('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email', {
    headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || (await response.text()).trim() !== `patchup-backend@${projectId}.iam.gserviceaccount.com`) {
    throw new Error('Cloud Run requires the dedicated PatchUp runtime service account.');
  }
}
