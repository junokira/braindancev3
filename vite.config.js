import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Vite configuration for BD Replay
//
// We enable the basic SSL plugin so that device orientation
// permission prompts work when using a LAN URL in development. See
// new issue N04 for details. In production builds the HTTPS
// requirement is handled by the deployment environment.

export default defineConfig({
  plugins: [basicSsl()],
  server: {
    https: true
  },
  build: {
    rollupOptions: {
      output: {
        // Place Three.js into its own chunk so that it can be cached
        // independently from application code. See new issue N20.
        manualChunks: {
          three: ['three']
        }
      }
    }
  }
});