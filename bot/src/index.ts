import { loadConfig } from "./config.js";
import { TSClient } from "./ts-client.js";
import { Player } from "./player.js";
import { startAPI } from "./api.js";

const config = loadConfig();
const ts = new TSClient(config);
const player = new Player(ts);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startAPI(config, ts, player);
// start() 是常驻守护循环，正常情况下不返回
await ts.start();

async function shutdown(): Promise<void> {
  console.log("正在退出…");
  player.shutdown(); // 保留队列落盘,重启后可恢复
  await ts.stop();
  process.exit(0);
}
