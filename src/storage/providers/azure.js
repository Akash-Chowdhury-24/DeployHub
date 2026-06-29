import { BlobServiceClient } from '@azure/storage-blob';
import fs from 'fs-extra';
import path from 'path';

export function createAzureProvider(env = process.env) {
  const connectionString = env.AZURE_CONNECTION_STRING;
  const container = env.AZURE_CONTAINER;

  if (!connectionString || !container) {
    throw new Error('Azure credentials incomplete. Set AZURE_CONNECTION_STRING and AZURE_CONTAINER.');
  }

  const client = BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = client.getContainerClient(container);

  async function upload(localPath, remoteKey) {
    const key = remoteKey || path.basename(localPath);
    const blockBlob = containerClient.getBlockBlobClient(key);
    await blockBlob.uploadFile(localPath);
  }

  async function download(remoteKey, localPath) {
    const blockBlob = containerClient.getBlockBlobClient(remoteKey);
    await fs.ensureDir(path.dirname(localPath));
    await blockBlob.downloadToFile(localPath);
  }

  async function verify(remoteKey) {
    const blockBlob = containerClient.getBlockBlobClient(remoteKey);
    return blockBlob.exists();
  }

  async function deleteObject(remoteKey) {
    const blockBlob = containerClient.getBlockBlobClient(remoteKey);
    await blockBlob.deleteIfExists();
  }

  async function testConnection() {
    await containerClient.getProperties();
  }

  return { upload, download, verify, delete: deleteObject, testConnection };
}

export default { createAzureProvider };
