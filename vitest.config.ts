// The pages' unit tests (gui/**/*.test.ts): `bun run test`. Same aliases as the build, in a
// browser-like DOM (happy-dom), never in a window of the app. A test that needs HTML parsed as
// a browser does (DOMPurify's) asks for jsdom at its top (`// @vitest-environment jsdom`).
import { defineConfig, mergeConfig } from 'vitest/config';
import vite from './vite.config.ts';

export default mergeConfig(
  vite,
  defineConfig({
    test: {
      environment: 'happy-dom',
      include: ['**/*.test.ts'],
    },
  }),
);
