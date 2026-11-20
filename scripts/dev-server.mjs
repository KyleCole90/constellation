import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build, createServer, preview } from "vite";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOST = "127.0.0.1";

export const startDevServer = async () => {
  const server = await createServer({
    root: ROOT,
    server: { host: HOST, port: 0, strictPort: true },
    logLevel: "error",
  });
  await server.listen();
  return {
    origin: `http://${HOST}:${server.httpServer.address().port}`,
    watcher: server.watcher,
    close: () => server.close(),
  };
};

export const startBuiltServer = async () => {
  const outDir = await mkdtemp(join(tmpdir(), "constellation-built-"));
  await build({ root: ROOT, logLevel: "error", build: { outDir, emptyOutDir: true } });
  const server = await preview({
    root: ROOT,
    build: { outDir },
    preview: { host: HOST, port: 0, strictPort: true },
    logLevel: "error",
  });
  return {
    origin: `http://${HOST}:${server.httpServer.address().port}`,
    close: async () => {
      await server.close();
      await rm(outDir, { recursive: true, force: true });
    },
  };
};
