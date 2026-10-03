import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Keep local secrets outside the client build's environment directory.
  envDir: './config/public',
  server: { port: 5173, strictPort: true, fs: { deny: ['.env', '.env.*', '**/.git/**'] } },
  build: { sourcemap: false },
  test: { include: ['src/**/*.test.ts'] },
})
