import { Client } from 'basic-ftp';
import fs from 'fs-extra';
import path from 'path';

export function createFtpProvider(env = process.env) {
  const host = env.FTP_HOST;
  const user = env.FTP_USER;
  const password = env.FTP_PASSWORD;
  const port = parseInt(env.FTP_PORT || '21', 10);
  const basePath = env.FTP_PATH || '/uploads';

  if (!host || !user) {
    throw new Error('FTP credentials incomplete. Set FTP_HOST, FTP_USER, and FTP_PASSWORD.');
  }

  async function withClient(fn) {
    const client = new Client();
    try {
      await client.access({ host, user, password, port, secure: false });
      return await fn(client);
    } finally {
      client.close();
    }
  }

  async function upload(localPath, remoteKey) {
    const remotePath = `${basePath}/${remoteKey || path.basename(localPath)}`;
    await withClient(async (client) => {
      await client.uploadFrom(localPath, remotePath);
    });
  }

  async function download(remoteKey, localPath) {
    const remotePath = `${basePath}/${remoteKey}`;
    await fs.ensureDir(path.dirname(localPath));
    await withClient(async (client) => {
      await client.downloadTo(localPath, remotePath);
    });
  }

  async function verify(remoteKey) {
    const remotePath = `${basePath}/${remoteKey}`;
    try {
      await withClient(async (client) => {
        await client.size(remotePath);
      });
      return true;
    } catch {
      return false;
    }
  }

  async function deleteObject(remoteKey) {
    const remotePath = `${basePath}/${remoteKey}`;
    await withClient(async (client) => {
      await client.remove(remotePath);
    });
  }

  async function testConnection() {
    await withClient(async (client) => {
      await client.pwd();
    });
  }

  return { upload, download, verify, delete: deleteObject, testConnection };
}

export default { createFtpProvider };
