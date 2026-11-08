import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { fileURLToPath } from 'node:url'
import { standardDecoratorPlugin } from '../vitest.shared.ts'

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [standardDecoratorPlugin(), tsconfigPaths({ projects: [fileURLToPath(new URL('../tsconfig.base.json', import.meta.url))] })],
  test: { include: ['dsh-requirements/tests/**/*.spec.ts'], environment: 'node' },
})
