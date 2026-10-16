import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// base './' — относительные пути: та же сборка работает под сервером панели и как статическая копия (GitHub Pages)
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
});
