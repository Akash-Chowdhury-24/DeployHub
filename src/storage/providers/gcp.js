import { Storage } from '@google-cloud/storage';
import fs from 'fs-extra';
import path from 'path';

export function createGcpProvider(env = process.env) {
  const bucketName = env.GCP_BUCKET;
  const keyFile = env.GCP_KEY_FILE;

  if (!bucketName) {
    throw new Error('GCP credentials incomplete. Set GCP_BUCKET and GCP_KEY_FILE.');
  }

  const storage = new Storage({
    projectId: env.GCP_PROJECT_ID,
    keyFilename: keyFile || undefined,
  });
  const bucket = storage.bucket(bucketName);

  async function upload(localPath, remoteKey) {
    const key = remoteKey || path.basename(localPath);
    await bucket.upload(localPath, { destination: key });
  }

  async function download(remoteKey, localPath) {
    await fs.ensureDir(path.dirname(localPath));
    await bucket.file(remoteKey).download({ destination: localPath });
  }

  async function verify(remoteKey) {
    const [exists] = await bucket.file(remoteKey).exists();
    return exists;
  }

  async function deleteObject(remoteKey) {
    await bucket.file(remoteKey).delete({ ignoreNotFound: true });
  }

  async function testConnection() {
    await bucket.getMetadata();
  }

  return { upload, download, verify, delete: deleteObject, testConnection };
}

export default { createGcpProvider };
