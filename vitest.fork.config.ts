import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['tests/fork.test.ts'], testTimeout: 60_000, hookTimeout: 90_000, fileParallelism: false } })
