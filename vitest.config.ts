// The pages' unit tests (gui/**/*.test.ts): `bun run test`. Same aliases as the build, in a
// browser-like DOM (jsdom: DOMPurify misreads happy-dom's), never in a window of the app.
import { defineConfig, mergeConfig } from 'vitest/config';
import vite from './vite.config.ts';

export default mergeConfig(
  vite,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['**/*.test.ts'],
    },
  }),
);
