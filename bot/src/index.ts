import { loadConfig } from "./config.js";
import { TSClient } from "./ts-client.js";
import { Player } from "./player.js";
import { startAPI } from "./api.js";

const config = loadConfig();
const ts = new TSClient(config);
const player = new Player(ts);

startAPI(config, ts, player);
await ts.start();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown(): Promise<void> {
  console.log("正在退出…");
  player.stopAll();
  await ts.stop();
  process.exit(0);
}
