import { fileURLToPath } from "node:url";

import { createServer } from "vite";

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
