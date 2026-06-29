import { Dropbox } from 'dropbox';
import fs from 'fs-extra';
import path from 'path';

export function createDropboxProvider(env = process.env) {
  const token = env.DROPBOX_ACCESS_TOKEN;
  if (!token) {
    throw new Error('Dropbox credentials incomplete. Set DROPBOX_ACCESS_TOKEN.');
  }

  const dbx = new Dropbox({ accessToken: token });

  async function upload(localPath, remoteKey) {
    const key = `/${remoteKey || path.basename(localPath)}`;
    const contents = await fs.readFile(localPath);
    await dbx.filesUpload({ path: key, contents, mode: { '.tag': 'overwrite' } });
  }

  async function download(remoteKey, localPath) {
    const key = remoteKey.startsWith('/') ? remoteKey : `/${remoteKey}`;
    const response = await dbx.filesDownload({ path: key });
    const fileBlob = response.result.fileBinary;
    await fs.ensureDir(path.dirname(localPath));
    await fs.writeFile(localPath, fileBlob);
  }

  async function verify(remoteKey) {
    const key = remoteKey.startsWith('/') ? remoteKey : `/${remoteKey}`;
    try {
      await dbx.filesGetMetadata({ path: key });
      return true;
    } catch {
      return false;
    }
  }

  async function deleteObject(remoteKey) {
    const key = remoteKey.startsWith('/') ? remoteKey : `/${remoteKey}`;
    await dbx.filesDeleteV2({ path: key });
  }

  async function testConnection() {
    await dbx.usersGetCurrentAccount();
  }

  return { upload, download, verify, delete: deleteObject, testConnection };
}

export default { createDropboxProvider };
