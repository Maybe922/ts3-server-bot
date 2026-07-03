import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // 开发时代理到本地面板进程
    proxy: { "/api": "http://127.0.0.1:8094" },
  },
  build: { outDir: "dist" },
});
