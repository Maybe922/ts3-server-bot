import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const CONFIG_FILE = join(DATA_DIR, "config.json");

export interface BotConfig {
  /** TS 服务器地址（面板部署时为 127.0.0.1） */
  serverHost: string;
  serverPort: number;
  nickname: string;
  /** 进服后加入的频道，空则待在默认频道 */
  defaultChannel: string;
  /** 控制 API 监听端口（仅绑定本机回环，面板代理访问） */
  apiPort: number;
  /** 控制 API 的 Bearer Token，面板侧持有同一份 */
  apiToken: string;
}

const defaults: BotConfig = {
  serverHost: "127.0.0.1",
  serverPort: 9987,
  nickname: "点歌姬",
  defaultChannel: "",
  apiPort: 3310,
  apiToken: "",
};

export function loadConfig(): BotConfig {
  mkdirSync(DATA_DIR, { recursive: true });
  let fromFile: Partial<BotConfig> = {};
  if (existsSync(CONFIG_FILE)) {
    fromFile = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  }
  const config = { ...defaults, ...fromFile };
  if (!config.apiToken) {
    config.apiToken = randomBytes(24).toString("hex");
  }
  // 回写，让首次生成的 token 和缺省字段落盘可见
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  return config;
}

export const dataDir = DATA_DIR;
