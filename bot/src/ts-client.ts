// TS 语音客户端封装：身份持久化、连接、断线重连、语音发送。
// 协议实现来自 MIT 库 @honeybbq/teamspeak-client，本文件只做业务包装。
import { Client, generateIdentity, identityFromString } from "@honeybbq/teamspeak-client";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dataDir, type BotConfig } from "./config.js";

const IDENTITY_FILE = join(dataDir, "identity.txt");
const RECONNECT_DELAY_MS = 5000;
const OPUS_MUSIC_CODEC = 5;

// 保持同一身份，Bot 在服务器上是稳定的"同一个用户"
function loadIdentity() {
  if (existsSync(IDENTITY_FILE)) {
    return identityFromString(readFileSync(IDENTITY_FILE, "utf8").trim());
  }
  const identity = generateIdentity(8);
  writeFileSync(IDENTITY_FILE, identity.toString());
  return identity;
}

export class TSClient {
  private client: Client | null = null;
  private config: BotConfig;
  private stopped = false;

  constructor(config: BotConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connectLoop();
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        return;
      } catch (err) {
        console.error(`连接失败: ${(err as Error).message}，${RECONNECT_DELAY_MS / 1000}s 后重试`);
        await sleep(RECONNECT_DELAY_MS);
      }
    }
  }

  private async connectOnce(): Promise<void> {
    const { serverHost, serverPort, nickname, defaultChannel } = this.config;
    const addr = serverPort === 9987 ? serverHost : `${serverHost}:${serverPort}`;
    const client = new Client(loadIdentity(), addr, nickname, {
      defaultChannel: defaultChannel || undefined,
    });

    client.on("disconnected", (err) => {
      console.error(`连接断开: ${err?.message ?? "正常下线"}`);
      this.client = null;
      if (!this.stopped) {
        void this.connectLoop();
      }
    });

    await client.connect();
    await client.waitConnected(AbortSignal.timeout(15_000));
    this.client = client;
    console.log(`已连接 ${addr}，昵称「${nickname}」`);
  }

  /** 发送一帧 20ms 的 Opus 音频。未连接时静默丢弃。 */
  sendOpusFrame(frame: Uint8Array): void {
    this.client?.sendVoice(frame, OPUS_MUSIC_CODEC);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.client?.disconnect();
    this.client = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
