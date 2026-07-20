import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'index-src.ts' },
  outDir: '.',
  format: ['cjs'],
  external: [
    'react',
    'react-dom',
    'react-redux',
    '@blueprintjs/core',
    'node:https',
    'node:path',
    'node:url',
    'views/create-store',
    'views/utils/selectors',
    'views/utils/game-utils',
  ],
  outExtensions: () => ({ js: '.js' }),
  clean: false,
  sourcemap: true,
  treeshake: true,
  shims: false,
  target: false,
})
