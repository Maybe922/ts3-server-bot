// 播放器：点歌队列 + ffmpeg 解码 + 20ms 帧节拍 + Opus 编码。
// 管线：音源 URL → ffmpeg(转 48kHz 双声道 PCM) → 按帧切分 → 音量增益 → Opus → TS 语音包
import { spawn, type ChildProcess } from "node:child_process";
import opusModule from "@discordjs/opus";
import ffmpegPath from "ffmpeg-static";
import { streamUrl, type Track } from "./netease.js";
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
}

export class Player {
  private ts: TSClient;
  private encoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
  private queue: Track[] = [];
  private current: Track | null = null;
  private ffmpeg: ChildProcess | null = null;
  private pcmBuffer: Buffer = Buffer.alloc(0);
  private ffmpegDone = false;
  private nextFrameAt = 0;
  private pump: ReturnType<typeof setInterval> | null = null;
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
    };
  }

  /** 点歌：入队，空闲则立即开播。 */
  async enqueue(track: Track): Promise<void> {
    this.queue.push(track);
    if (!this.current) {
      await this.playNext();
    }
  }

  async skip(): Promise<void> {
    this.stopCurrent();
    await this.playNext();
  }

  stopAll(): void {
    this.queue = [];
    this.stopCurrent();
  }

  private async playNext(): Promise<void> {
    this.stopCurrent();
    const track = this.queue.shift();
    if (!track) {
      return;
    }
    let url: string;
    try {
      url = await streamUrl(track.id);
    } catch (err) {
      console.error(`「${track.name}」${(err as Error).message}，跳到下一首`);
      return this.playNext();
    }
    this.current = track;
    this.startFfmpeg(url);
    console.log(`▶ ${track.name} - ${track.artist}`);
  }

  private startFfmpeg(url: string): void {
    this.pcmBuffer = Buffer.alloc(0);
    this.ffmpegDone = false;
    const ff = spawn(ffmpegPath as unknown as string, [
      "-loglevel", "quiet",
      "-i", url,
      "-f", "s16le",
      "-ar", String(SAMPLE_RATE),
      "-ac", String(CHANNELS),
      "pipe:1",
    ]);
    this.ffmpeg = ff;

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
    this.ffmpeg?.kill("SIGKILL");
    this.ffmpeg = null;
    this.current = null;
    this.pcmBuffer = Buffer.alloc(0);
  }
}
