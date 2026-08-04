import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const SRC = resolve(__dirname, 'src');

export default defineConfig(({ mode }) => {
  if (mode === 'umd') {
    return {
      build: {
        outDir: 'dist',
        emptyOutDir: false,
        target: 'es2020',
        lib: {
          entry: resolve(SRC, 'umd.ts'),
          name: 'Pusha',
          formats: ['umd'],
          fileName: () => 'pusha.min.js',
        },
        minify: true,
        sourcemap: true,
      },
    };
  }

  return {
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'es2020',
      sourcemap: true,
      lib: {
        entry: {
          'pusha.esm': resolve(SRC, 'index.ts'),
          registry: resolve(SRC, 'registry.ts'),
          hooks: resolve(SRC, 'hooks.ts'),
          transitions: resolve(SRC, 'transitions.ts'),
          prefetch: resolve(SRC, 'prefetch.ts'),
          islands: resolve(SRC, 'islands.ts'),
          'active-links': resolve(SRC, 'active-links.ts'),
          diagnostics: resolve(SRC, 'diagnostics.ts'),
        },
        formats: ['es'],
      },
      rollupOptions: {
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          preserveModules: false,
        },
      },
    },
  };
});
