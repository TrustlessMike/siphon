import { createSiphonServer } from './app.js';

const PORT = Number(process.env.PORT ?? 4420);
const HOST = process.env.HOST ?? '127.0.0.1';

const { server } = createSiphonServer();

server.listen(PORT, HOST, () => {
  console.log(`Siphon EVM -> Solana Migrator running at http://${HOST}:${PORT}`);
});
