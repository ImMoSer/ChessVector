import { defineConfig } from 'vite';


export default defineConfig({
  // ... другие ваши настройки Vite ...
/*   server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  }, */
 /*  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] // Пример, если используете ffmpeg, для Stockfish это не нужно, но полезно знать
  } */
});