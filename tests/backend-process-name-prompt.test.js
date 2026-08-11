import { backendProcessNamePromptMessage } from '../src/deployment/init-prompts.js';

describe('backendProcessNamePromptMessage', () => {
  test('Node frameworks keep the PM2 label', () => {
    expect(backendProcessNamePromptMessage('express', 'myapi', 'backend')).toMatch(
      /^PM2 process name/
    );
    expect(backendProcessNamePromptMessage('nestjs', 'myapi', 'backend')).toMatch(
      /^PM2 process name/
    );
  });

  test('Python / Go / Java / Rails use generic process-name label', () => {
    expect(backendProcessNamePromptMessage('fastapi', 'myapi', 'backend')).toMatch(
      /^Process name for your backend \(identifies/
    );
    expect(backendProcessNamePromptMessage('django', 'myapi', 'backend')).not.toMatch(/PM2/);
    expect(backendProcessNamePromptMessage('go', 'myapi', 'backend')).not.toMatch(/PM2/);
    expect(backendProcessNamePromptMessage('spring', 'myapi', 'backend')).not.toMatch(/PM2/);
    expect(backendProcessNamePromptMessage('rails', 'myapi', 'backend')).not.toMatch(/PM2/);
  });

  test('both project type uses -api example in the prompt', () => {
    expect(backendProcessNamePromptMessage('fastapi', 'shop', 'both')).toContain('shop-api');
  });
});
