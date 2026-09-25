import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 单页应用：不代理任何在线转换接口，全部编码在浏览器本地完成。
export default defineConfig({
  plugins: [vue()],
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173
  }
});
