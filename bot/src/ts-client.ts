// TS 语音客户端封装：身份持久化、连接、断线重连、语音发送。
// 协议实现来自 MIT 库 @honeybbq/teamspeak-client，本文件只做业务包装。
import { Client, generateIdentity, identityFromString } from "@honeybbq/teamspeak-client";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
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

  /** 单一守护循环：连接 → 驻留至断开 → 等待 → 重连。
   * 永不静默退出；任何路径的失败都会释放连接并进入下一轮。 */
  async start(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try {
        await this.runSession();
      } catch (err) {
        console.error(`连接失败: ${(err as Error).message}，${RECONNECT_DELAY_MS / 1000}s 后重试`);
      }
      if (!this.stopped) {
        await sleep(RECONNECT_DELAY_MS);
      }
    }
  }

  /** 建立一次连接并驻留，直到断开才返回。 */
  private async runSession(): Promise<void> {
    const { serverHost, serverPort, nickname, defaultChannel } = this.config;
    const addr = serverPort === 9987 ? serverHost : `${serverHost}:${serverPort}`;
    const client = new Client(loadIdentity(), addr, nickname, {
      defaultChannel: defaultChannel || undefined,
    });

    // 断开信号：无论发生在握手期还是稳定期，都由本循环统一收尾
    const ended = new Promise<void>((resolve) => {
      client.on("disconnected", (err) => {
        console.error(`连接断开: ${err?.message ?? "正常下线"}`);
        resolve();
      });
    });

    try {
      await client.connect();
      await client.waitConnected(AbortSignal.timeout(15_000));
    } catch (err) {
      await client.disconnect().catch(() => {}); // 释放失败连接的套接字
      throw err;
    }
    this.client = client;
    console.log(`已连接 ${addr}，昵称「${nickname}」`);
    await ended; // 驻留至断开
    this.client = null;
  }

  /** 发送一帧 20ms 的 Opus 音频。未连接时静默丢弃。 */
  sendOpusFrame(frame: Uint8Array): void {
    this.client?.sendVoice(frame, OPUS_MUSIC_CODEC);
  }

  /** 把图片设为 Bot 头像（TS 客户端信息栏显示）。
   * 协议流程：上传到虚拟路径 /avatar → clientupdate 声明内容 MD5。 */
  async setAvatar(image: Buffer): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }
    const info = await client.fileTransferInitUpload(0n, "/avatar", "", BigInt(image.length), true);
    await client.uploadFileData(this.config.serverHost, info, Readable.from(image));
    const md5 = createHash("md5").update(image).digest("hex");
    await client.execCommand(`clientupdate client_flag_avatar=${md5}`);
  }

  /** 清除头像（停止播放后恢复"素颜"）。 */
  async clearAvatar(): Promise<void> {
    await this.client?.execCommand("clientupdate client_flag_avatar=");
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
