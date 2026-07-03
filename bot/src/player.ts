// 播放器：点歌队列 + ffmpeg 解码 + 20ms 帧节拍 + Opus 编码。
// 管线：音源 URL → ffmpeg(转 48kHz 双声道 PCM) → 按帧切分 → 音量增益 → Opus → TS 语音包
import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import opusModule from "@discordjs/opus";
import ffmpegPath from "ffmpeg-static";
import { streamUrl, coverImage, type Track } from "./netease.js";
import type { TSClient } from "./ts-client.js";

const { OpusEncoder } = opusModule;

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_MS = 20;
const PCM_FRAME_BYTES = (SAMPLE_RATE / 1000) * FRAME_MS * CHANNELS * 2; // 3840
// 帧泵空转间隔：小于帧长，用时间戳对齐防漂移
const PUMP_INTERVAL_MS = 5;

export interface PlayerStatus {
  playing: boolean;
  current: Track | null;
  queue: Track[];
  volume: number;
  /** 面向用户的最近一条播放提示(如"VIP 歌曲已跳过"),正常播放时为 null */
  notice: string | null;
}

export class Player {
  private ts: TSClient;
  private encoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
  private queue: Track[] = [];
  private current: Track | null = null;
  private ffmpeg: ChildProcess | null = null;
  private download: Readable | null = null;
  private pcmBuffer: Buffer = Buffer.alloc(0);
  private ffmpegDone = false;
  private nextFrameAt = 0;
  private pump: ReturnType<typeof setInterval> | null = null;
  private notice: string | null = null;
  /** 0-100 */
  volume = 60;

  constructor(ts: TSClient) {
    this.ts = ts;
  }

  status(): PlayerStatus {
    return {
      playing: this.current !== null,
      current: this.current,
      queue: [...this.queue],
      volume: this.volume,
      notice: this.notice,
    };
  }

  /** 点歌：入队，空闲则立即开播。 */
  async enqueue(track: Track): Promise<void> {
    this.queue.push(track);
    if (!this.current) {
      await this.playNext();
    }
  }

  /** 整单入队（歌单），空闲则立即开播。 */
  async enqueueMany(tracks: Track[]): Promise<void> {
    this.queue.push(...tracks);
    if (!this.current) {
      await this.playNext();
    }
  }

  /** 打乱当前队列。 */
  shuffle(): void {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
  }

  async skip(): Promise<void> {
    this.stopCurrent();
    await this.playNext();
  }

  stopAll(): void {
    this.queue = [];
    this.notice = null;
    this.stopCurrent();
    void this.ts.clearAvatar().catch(() => {});
  }

  private async playNext(): Promise<void> {
    this.stopCurrent();
    const track = this.queue.shift();
    if (!track) {
      void this.ts.clearAvatar().catch(() => {});
      return;
    }
    // 下载由 Node 完成再喂给 ffmpeg 解码:静态编译的 ffmpeg
    // 在部分 Linux 上一走网络(DNS)就段错误,不能让它自己拉流
    let body: ReadableStream<Uint8Array>;
    try {
      const url = await streamUrl(track.id);
      const res = await fetch(url);
      if (!res.ok || !res.body) {
        throw new Error(`音源响应异常(HTTP ${res.status})`);
      }
      body = res.body;
    } catch (err) {
      console.error(`「${track.name}」${(err as Error).message}，跳到下一首`);
      this.notice = `「${track.name}」${(err as Error).message}，已跳过`;
      return this.playNext();
    }
    this.notice = null;
    this.current = track;
    this.startFfmpeg(body);
    void this.updateCover(track);
    console.log(`▶ ${track.name} - ${track.artist}`);
  }

  /** 把当前歌曲封面设为 Bot 头像。异步进行，失败只记日志，绝不影响播放。 */
  private async updateCover(track: Track): Promise<void> {
    try {
      const image = await coverImage(track.id);
      // 取图期间可能已切歌，只在还是这首时才换头像
      if (image && this.current?.id === track.id) {
        await this.ts.setAvatar(image);
      }
    } catch (err) {
      console.error(`封面更新失败: ${(err as Error).message}`);
    }
  }

  private startFfmpeg(source: ReadableStream<Uint8Array>): void {
    this.pcmBuffer = Buffer.alloc(0);
    this.ffmpegDone = false;
    const ff = spawn(ffmpegPath as unknown as string, [
      "-loglevel", "quiet",
      "-i", "pipe:0",
      "-f", "s16le",
      "-ar", String(SAMPLE_RATE),
      "-ac", String(CHANNELS),
      "pipe:1",
    ]);
    this.ffmpeg = ff;

    const download = Readable.fromWeb(source as unknown as import("node:stream/web").ReadableStream);
    this.download = download;
    download.on("error", () => {}); // 下载中断 → ffmpeg 读到 EOF 自然收尾
    ff.stdin!.on("error", () => {}); // 切歌 kill ffmpeg 后的 EPIPE
    download.pipe(ff.stdin!);

    ff.stdout!.on("data", (chunk: Buffer) => {
      this.pcmBuffer = Buffer.concat([this.pcmBuffer, chunk]);
      // 简单背压：缓冲超过 5 秒就暂停读取
      if (this.pcmBuffer.length > PCM_FRAME_BYTES * 250) {
        ff.stdout!.pause();
      }
    });
    ff.on("close", () => {
      this.ffmpegDone = true;
    });
    ff.on("error", (err) => {
      console.error(`ffmpeg 错误: ${err.message}`);
      this.ffmpegDone = true;
    });

    this.nextFrameAt = Date.now();
    this.pump = setInterval(() => this.pumpFrames(), PUMP_INTERVAL_MS);
  }

  /** 按 20ms 节拍送帧，时间戳对齐避免累计漂移。 */
  private pumpFrames(): void {
    const now = Date.now();
    while (now >= this.nextFrameAt) {
      if (this.pcmBuffer.length >= PCM_FRAME_BYTES) {
        const pcm = this.pcmBuffer.subarray(0, PCM_FRAME_BYTES);
        this.pcmBuffer = this.pcmBuffer.subarray(PCM_FRAME_BYTES);
        if (this.pcmBuffer.length < PCM_FRAME_BYTES * 100) {
          this.ffmpeg?.stdout?.resume();
        }
        this.ts.sendOpusFrame(this.encoder.encode(this.applyGain(pcm)));
        this.nextFrameAt += FRAME_MS;
      } else if (this.ffmpegDone) {
        // 播完了，进下一首
        void this.playNext();
        return;
      } else {
        // 网络卡了缓冲不足：等下一轮，重置节拍防止追帧爆发
        this.nextFrameAt = now + FRAME_MS;
        return;
      }
    }
  }

  /** 16-bit PCM 逐样本乘增益。 */
  private applyGain(pcm: Buffer): Buffer {
    if (this.volume >= 100) {
      return pcm;
    }
    const gain = this.volume / 100;
    const out = Buffer.allocUnsafe(pcm.length);
    for (let i = 0; i < pcm.length; i += 2) {
      out.writeInt16LE(Math.round(pcm.readInt16LE(i) * gain), i);
    }
    return out;
  }

  private stopCurrent(): void {
    if (this.pump) {
      clearInterval(this.pump);
      this.pump = null;
    }
    this.download?.destroy();
    this.download = null;
    this.ffmpeg?.kill("SIGKILL");
    this.ffmpeg = null;
    this.current = null;
    this.pcmBuffer = Buffer.alloc(0);
  }
}
