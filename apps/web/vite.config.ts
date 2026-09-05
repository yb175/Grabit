import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Command View talks to @grabit/api directly via VITE_API_URL
// (default http://localhost:3100).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
})