import {
  isNotFoundStorageError,
  summarizeStorageError,
} from '../src/storage/storage-errors.js';

describe('storage-errors helpers', () => {
  test('summarizeStorageError keeps a concise AccessDenied reason', () => {
    const err = new Error('Access Denied');
    err.name = 'AccessDenied';
    expect(summarizeStorageError(err)).toMatch(/AccessDenied.*Access Denied/);
  });

  test('summarizeStorageError truncates long multi-line SDK dumps', () => {
    const err = new Error(`${'x'.repeat(300)}\nstack line 2\nstack line 3`);
    const summary = summarizeStorageError(err);
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary).not.toContain('\n');
  });

  test('isNotFoundStorageError recognizes S3 NoSuchKey', () => {
    const err = Object.assign(new Error('The specified key does not exist.'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
    expect(isNotFoundStorageError(err)).toBe(true);
  });

  test('isNotFoundStorageError does not treat AccessDenied as missing', () => {
    const err = Object.assign(new Error('Access Denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    expect(isNotFoundStorageError(err)).toBe(false);
  });

  test('isNotFoundStorageError does not treat credential errors as missing', () => {
    const err = new Error('The AWS Access Key Id you provided does not exist in our records.');
    err.name = 'InvalidAccessKeyId';
    expect(isNotFoundStorageError(err)).toBe(false);
  });
});
