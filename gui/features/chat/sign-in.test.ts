import { expect, test } from 'vitest';
import { needsSignIn } from './sign-in';

test('an expired or refused sign-in needs signing in again', () => {
  expect(needsSignIn('Failed to authenticate: OAuth session expired and could not be refreshed')).toBe(true);
  expect(needsSignIn('Failed to authenticate. API Error: 401 OAuth access token is invalid.')).toBe(true);
  expect(needsSignIn('Not logged in · Please run /login')).toBe(true);
  expect(needsSignIn('Invalid API key · Please run /login')).toBe(true);
});

test('other errors do not', () => {
  expect(needsSignIn('API Error: 529 Overloaded')).toBe(false);
  expect(needsSignIn('**Oops:** Claude Code exited with code 1')).toBe(false);
});
