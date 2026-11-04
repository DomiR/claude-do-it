import { defineConfig } from 'vite'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), foldkit()],
  server: {
    proxy: {
      '/rpc': 'http://127.0.0.1:47100',
      '/auth': 'http://127.0.0.1:47100',
    },
  },
})
