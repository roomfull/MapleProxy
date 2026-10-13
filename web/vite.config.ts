import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const backendPort = Number(process.env.PORT ?? 8317);
const backend = `http://127.0.0.1:${backendPort}`;
// This development-only middleware validates browser Origin BEFORE proxy rewrites.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    react(),
    {
      name: "local-origin-guard",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (
            !request.url?.startsWith("/api") &&
            !request.url?.startsWith("/v1")
          )
            return next();
          const host = request.headers.host;
          if (host !== "127.0.0.1:5173" && host !== "localhost:5173") {
            response.writeHead(403);
            response.end("Invalid local Host");
            return;
          }
          if (
            request.url.startsWith("/api/admin/") &&
            !["GET", "HEAD"].includes(request.method ?? "") &&
            request.headers.origin !== `http://${host}`
          ) {
            response.writeHead(403);
            response.end("Invalid local Origin");
            return;
          }
          if (request.headers.origin) {
            if (request.headers.origin !== `http://${host}`) {
              response.writeHead(403);
              response.end("Invalid local Origin");
              return;
            }
            request.headers.origin = backend;
          }
          next();
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    allowedHosts: ["localhost"],
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/v1": { target: backend, changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
