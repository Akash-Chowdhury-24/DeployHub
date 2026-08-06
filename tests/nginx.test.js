import {
  sanitizeNginxProjectName,
  getNginxSitesAvailablePath,
  getNginxSitesEnabledPath,
  getNginxConfDPath,
  formatPasswordlessSudoGuidance,
} from '../src/utils/nginx.js';

describe('nginx path helpers', () => {
  test('sanitizeNginxProjectName replaces spaces and special chars', () => {
    expect(sanitizeNginxProjectName('demo react project')).toBe('demo-react-project');
  });

  test('debian layout paths are unique per project', () => {
    expect(getNginxSitesAvailablePath('my-app')).toBe('/etc/nginx/sites-available/my-app');
    expect(getNginxSitesEnabledPath('my-app')).toBe('/etc/nginx/sites-enabled/my-app');
  });

  test('rhel/amazon linux conf.d path includes .conf suffix', () => {
    expect(getNginxConfDPath('demo-react-project')).toBe(
      '/etc/nginx/conf.d/demo-react-project.conf'
    );
    expect(getNginxConfDPath(sanitizeNginxProjectName('demo react project'))).toBe(
      '/etc/nginx/conf.d/demo-react-project.conf'
    );
  });

  test('formatPasswordlessSudoGuidance includes ssh user', () => {
    const message = formatPasswordlessSudoGuidance('ec2-user');
    expect(message).toContain('ec2-user');
    expect(message).toContain('visudo');
  });
});
