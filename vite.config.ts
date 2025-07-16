import { defineConfig } from 'vite'

export default defineConfig(async () => {
  const react = (await import('@vitejs/plugin-react')).default
  const tsconfigPaths = (await import('vite-tsconfig-paths')).default
  return {
    plugins: [react(), tsconfigPaths()],
    server: {
      open: false,
    },
  }
})
