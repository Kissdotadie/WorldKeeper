import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** 路径里是否有一段叫 name 的 node_modules 包（避免 "three" 误配到名字里带 three 的包） */
const pkg = (id: string, name: string) => id.includes(`/node_modules/${name}/`)

// 构建产物由 FastAPI 直接托管（口子 A3），所以用相对 base，放在任何路径下都能跑。
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // 单文件 2.1MB 的告警（P11-B1）。拆两刀：
    // ① 视图走 import() 按需加载（在 shell/panels.tsx 里用 lazy）
    // ② vendor 按「谁大谁单独一组」拆开 —— 三个 3D/图表库占了总包一半以上，
    //    而首屏（汇总/名册）根本用不到，单独成块后可以一直待在缓存里，改业务代码不会让它失效
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return
          if (pkg(id, 'three') || pkg(id, '@react-three') || pkg(id, '3d-force-graph') ||
              pkg(id, 'three-forcegraph') || pkg(id, 'three-render-objects')) return 'vendor-3d'
          if (pkg(id, 'echarts') || pkg(id, 'zrender')) return 'vendor-charts'
          if (pkg(id, 'dockview') || pkg(id, 'dockview-core')) return 'vendor-dockview'
          if (pkg(id, 'react') || pkg(id, 'react-dom') || pkg(id, 'scheduler')) return 'vendor-react'
          return 'vendor'
        },
      },
    },
    // vendor-3d（three.js 全家桶）天生 1.2MB，且**是懒加载** —— 首屏根本不下载它。
    // 阈值放宽到它之上，免得每次构建都报一条改不动也没必要改的警。
    chunkSizeWarningLimit: 1400,
  },
  server: {
    port: 5173,
    strictPort: false,
    // 开发期把 /api 转给后端，免去跨域
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
    },
  },
})
