import { google } from 'googleapis';
import fs from 'fs-extra';
import path from 'path';
import { createReadStream, createWriteStream } from 'fs';

export function createGdriveProvider(env = process.env) {
  const clientId = env.GDRIVE_CLIENT_ID;
  const clientSecret = env.GDRIVE_CLIENT_SECRET;
  const refreshToken = env.GDRIVE_REFRESH_TOKEN;
  const folderId = env.GDRIVE_FOLDER_ID;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Google Drive credentials incomplete. Set GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, and GDRIVE_REFRESH_TOKEN.'
    );
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  async function upload(localPath, remoteKey) {
    const fileName = remoteKey || path.basename(localPath);
    const metadata = { name: fileName };
    if (folderId) metadata.parents = [folderId];

    await drive.files.create({
      requestBody: metadata,
      media: { body: createReadStream(localPath) },
      fields: 'id',
    });
  }

  async function download(remoteKey, localPath) {
    const res = await drive.files.list({
      q: `name='${remoteKey}' and trashed=false`,
      fields: 'files(id)',
    });
    const file = res.data.files?.[0];
    if (!file?.id) throw new Error(`Google Drive file not found: ${remoteKey}`);

    await fs.ensureDir(path.dirname(localPath));
    const dest = createWriteStream(localPath);
    const response = await drive.files.get(
      { fileId: file.id, alt: 'media' },
      { responseType: 'stream' }
    );
    await new Promise((resolve, reject) => {
      response.data.pipe(dest);
      dest.on('finish', resolve);
      dest.on('error', reject);
    });
  }

  async function verify(remoteKey) {
    const res = await drive.files.list({
      q: `name='${remoteKey}' and trashed=false`,
      fields: 'files(id)',
    });
    return (res.data.files?.length || 0) > 0;
  }

  async function deleteObject(remoteKey) {
    const res = await drive.files.list({
      q: `name='${remoteKey}' and trashed=false`,
      fields: 'files(id)',
    });
    for (const file of res.data.files || []) {
      if (file.id) await drive.files.delete({ fileId: file.id });
    }
  }

  async function testConnection() {
    await drive.files.list({ pageSize: 1, fields: 'files(id)' });
  }

  return { upload, download, verify, delete: deleteObject, testConnection };
}

export default { createGdriveProvider };
