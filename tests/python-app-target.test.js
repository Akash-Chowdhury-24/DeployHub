import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  detectDjangoWsgiTarget,
  detectFlaskAppTarget,
  detectDjangoWsgiPackageDir,
  extractGunicornTarget,
} from '../src/utils/python-app-target.js';
import { getBackendInfo } from '../src/detectors/backend.detector.js';

describe('python-app-target', () => {
  /** @type {string} */
  let tmp;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-py-target-'));
  });

  afterEach(async () => {
    await fs.remove(tmp).catch(() => {});
  });

  describe('extractGunicornTarget', () => {
    test('parses module:callable after gunicorn', () => {
      expect(
        extractGunicornTarget('gunicorn myapp.wsgi:application --bind 0.0.0.0:8000')
      ).toBe('myapp.wsgi:application');
      expect(extractGunicornTarget('gunicorn app:app --bind 0.0.0.0:5000')).toBe('app:app');
      expect(extractGunicornTarget('gunicorn wsgi:app')).toBe('wsgi:app');
    });

    test('skips flags with values', () => {
      expect(
        extractGunicornTarget(
          'gunicorn --bind 0.0.0.0:8000 --workers 2 mysite.wsgi:application --daemon'
        )
      ).toBe('mysite.wsgi:application');
    });

    test('returns null when missing', () => {
      expect(extractGunicornTarget(null)).toBeNull();
      expect(extractGunicornTarget('uvicorn main:app')).toBeNull();
      expect(extractGunicornTarget('')).toBeNull();
    });
  });

  describe('detectDjangoWsgiTarget', () => {
    test('standard django-admin startproject myapp layout', async () => {
      await fs.writeFile(path.join(tmp, 'manage.py'), '# manage');
      await fs.ensureDir(path.join(tmp, 'myapp'));
      await fs.writeFile(path.join(tmp, 'myapp', 'wsgi.py'), 'application = None\n');
      expect(detectDjangoWsgiTarget(tmp)).toBe('myapp.wsgi:application');
      expect(detectDjangoWsgiPackageDir(tmp)).toBe('myapp');
    });

    test('cookiecutter-style config/wsgi.py', async () => {
      await fs.writeFile(path.join(tmp, 'manage.py'), '# manage');
      await fs.ensureDir(path.join(tmp, 'config'));
      await fs.writeFile(path.join(tmp, 'config', 'wsgi.py'), 'application = None\n');
      expect(detectDjangoWsgiTarget(tmp)).toBe('config.wsgi:application');
      expect(detectDjangoWsgiPackageDir(tmp)).toBe('config');
    });

    test('root wsgi.py', async () => {
      await fs.writeFile(path.join(tmp, 'wsgi.py'), 'application = None\n');
      expect(detectDjangoWsgiTarget(tmp)).toBe('wsgi:application');
      expect(detectDjangoWsgiPackageDir(tmp)).toBe('');
    });

    test('fallback when no wsgi.py', () => {
      expect(detectDjangoWsgiTarget(tmp)).toBe('config.wsgi:application');
      expect(detectDjangoWsgiPackageDir(tmp)).toBeNull();
    });

    test('skips venv directories', async () => {
      await fs.writeFile(path.join(tmp, 'manage.py'), '#');
      await fs.ensureDir(path.join(tmp, 'venv', 'lib'));
      await fs.writeFile(path.join(tmp, 'venv', 'lib', 'wsgi.py'), 'x');
      await fs.ensureDir(path.join(tmp, 'mysite'));
      await fs.writeFile(path.join(tmp, 'mysite', 'wsgi.py'), 'application = None\n');
      expect(detectDjangoWsgiTarget(tmp)).toBe('mysite.wsgi:application');
    });
  });

  describe('detectFlaskAppTarget', () => {
    test('app.py with app =', async () => {
      await fs.writeFile(path.join(tmp, 'app.py'), 'from flask import Flask\napp = Flask(__name__)\n');
      expect(detectFlaskAppTarget(tmp)).toBe('app:app');
    });

    test('wsgi.py with app =', async () => {
      await fs.writeFile(path.join(tmp, 'wsgi.py'), 'app = Flask(__name__)\n');
      expect(detectFlaskAppTarget(tmp)).toBe('wsgi:app');
    });

    test('application.py with application =', async () => {
      await fs.writeFile(
        path.join(tmp, 'application.py'),
        'application = Flask(__name__)\n'
      );
      expect(detectFlaskAppTarget(tmp)).toBe('application:application');
    });

    test('fallback app:app', () => {
      expect(detectFlaskAppTarget(tmp)).toBe('app:app');
    });
  });

  describe('getBackendInfo uses detection', () => {
    test('django startCommand reflects myapp.wsgi', async () => {
      await fs.writeFile(path.join(tmp, 'requirements.txt'), 'django\n');
      await fs.writeFile(path.join(tmp, 'manage.py'), '#');
      await fs.ensureDir(path.join(tmp, 'myapp'));
      await fs.writeFile(path.join(tmp, 'myapp', 'wsgi.py'), 'application = None\n');
      const info = getBackendInfo('django', tmp);
      expect(info.startCommand).toBe(
        'gunicorn myapp.wsgi:application --bind 0.0.0.0:8000'
      );
    });

    test('flask startCommand reflects wsgi:app', async () => {
      await fs.writeFile(path.join(tmp, 'requirements.txt'), 'flask\n');
      await fs.writeFile(path.join(tmp, 'wsgi.py'), 'app = Flask(__name__)\n');
      const info = getBackendInfo('flask', tmp);
      expect(info.startCommand).toBe('gunicorn wsgi:app --bind 0.0.0.0:5000');
    });
  });
});
