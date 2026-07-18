// 播放器：点歌队列 + ffmpeg 解码 + 20ms 帧节拍 + Opus 编码。
// 管线：音源 URL → ffmpeg(转 48kHz 双声道 PCM) → 按帧切分 → 音量增益 → Opus → TS 语音包
import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough, Readable } from "node:stream";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import opusModule from "@discordjs/opus";
import ffmpegPath from "ffmpeg-static";
import { streamUrl, coverImage, type Track } from "./netease.js";
import type { TSClient } from "./ts-client.js";
import { dataDir } from "./config.js";

const { OpusEncoder } = opusModule;

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_MS = 20;
const PCM_FRAME_BYTES = (SAMPLE_RATE / 1000) * FRAME_MS * CHANNELS * 2; // 3840
// 帧泵空转间隔：小于帧长，用时间戳对齐防漂移
const PUMP_INTERVAL_MS = 5;

// 上一首回溯上限
const HISTORY_MAX = 50;
// 音频断流超过该时长视为卡死，自动跳下一首
const STALL_TIMEOUT_MS = 20_000;
// 队列落盘，机器人重启后不丢
const QUEUE_FILE = join(dataDir, "queue.json");
// 整首歌预缓存水位:下载全速拉进内存,不让网络连接跟着解码节奏细水长流——
// 跨境 CDN 会掐闲置慢连接,表现为每首歌放三五分钟就"断流跳歌"(2026-07-18 线上实锤)
const PREBUFFER_BYTES = 32 * 1024 * 1024;
// 取直链/等响应头的上限:黑洞连接若不设限,switchPending 会永久卡住、点歌全冻结。
// 只保护"落地前",不作用于正文下载(正文断流由 20s 看门狗兜底)
const SWITCH_STEP_TIMEOUT_MS = 20_000;

/** 给不支持 AbortSignal 的 Promise 套超时；超时后原 Promise 继续悬着但结果被丢弃。 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface PlayerStatus {
  playing: boolean;
  paused: boolean;
  /** 是否有可回退的上一首 */
  hasPrevious: boolean;
  /** 当前曲目已播放时长（毫秒），无播放为 0 */
  positionMs: number;
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
  private history: Track[] = [];
  private current: Track | null = null;
  private paused = false;
  private ffmpeg: ChildProcess | null = null;
  private download: Readable | null = null;
  private prebuffer: PassThrough | null = null;
  private pcmBuffer: Buffer = Buffer.alloc(0);
  // 播放管线代际:每次切歌/停止都 +1。异步取直链期间若代际变了,说明这条管线
  // 已被更晚的操作取代,必须放弃落地——这是防"并发切歌泄漏帧泵/ffmpeg"的核心闸门
  // (2026-07-18 线上事故:泄漏的帧泵各自触发断流跳歌,滚雪球出 283 个僵尸 ffmpeg 吃光内存)
  private session = 0;
  /** 是否有切歌正在取直链的路上。enqueue 据此判断"空闲"，防止把在途切歌顶掉 */
  private switchPending = false;
  /** 在途切歌对应的曲目（已 shift 出队列还没开播）。shutdown 时据此还原，不丢歌 */
  private fetching: Track | null = null;
  // 已发送的音频帧数——每帧恒定 20ms，帧数×20 即精确播放进度，暂停时自然停走
  private playedFrames = 0;
  private ffmpegDone = false;
  private stalledSince = 0;
  private nextFrameAt = 0;
  private pump: ReturnType<typeof setInterval> | null = null;
  private notice: string | null = null;
  /** 0-100 */
  volume = 60;

  constructor(ts: TSClient) {
    this.ts = ts;
    this.restoreQueue();
  }

  /** 启动时恢复上次的队列（不自动开播，由用户按 ⏭ 开始）。 */
  private restoreQueue(): void {
    try {
      if (!existsSync(QUEUE_FILE)) {
        return;
      }
      const saved: unknown = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
      if (Array.isArray(saved) && saved.length > 0) {
        this.queue = saved as Track[];
        this.notice = `已恢复上次的队列（${saved.length} 首），点 ⏭ 开始播放`;
      }
    } catch {
      // 队列缓存损坏就从空队列开始
    }
  }

  private persistQueue(): void {
    try {
      writeFileSync(QUEUE_FILE, JSON.stringify(this.queue));
    } catch {
      // 落盘失败不影响播放
    }
  }

  status(): PlayerStatus {
    return {
      playing: this.current !== null,
      paused: this.paused,
      hasPrevious: this.history.length > 0,
      positionMs: this.current ? this.playedFrames * FRAME_MS : 0,
      current: this.current,
      queue: [...this.queue],
      volume: this.volume,
      notice: this.notice,
    };
  }

  /** 点歌：入队，空闲则立即开播（切歌在途也算忙，不能顶掉它）。 */
  async enqueue(track: Track): Promise<void> {
    this.queue.push(track);
    this.persistQueue();
    if (!this.current && !this.switchPending) {
      await this.playNext();
    }
  }

  /** 整单入队（歌单），空闲则立即开播。 */
  async enqueueMany(tracks: Track[]): Promise<void> {
    this.queue.push(...tracks);
    this.persistQueue();
    if (!this.current && !this.switchPending) {
      await this.playNext();
    }
  }

  /** 从队列移除一首。index 与 id 双重校验：刷新间隙队列变动时按 id 兜底。 */
  remove(index: number, id: number): Track | null {
    let at = index;
    if (this.queue[at]?.id !== id) {
      at = this.queue.findIndex((t) => t.id === id);
    }
    if (at < 0 || at >= this.queue.length) {
      return null;
    }
    const [removed] = this.queue.splice(at, 1);
    this.persistQueue();
    return removed;
  }

  /** 打乱当前队列。 */
  shuffle(): void {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    this.persistQueue();
  }

  /** 下一首（playNext 内部会先收掉当前曲并记入历史）。 */
  async skip(): Promise<void> {
    await this.playNext();
  }

  /** 上一首：当前曲退回队首，从历史里取最近一首重播。 */
  async previous(): Promise<void> {
    const prev = this.history.pop();
    if (!prev) {
      this.notice = "没有上一首了";
      return;
    }
    if (this.current) {
      this.queue.unshift(this.current);
    }
    this.queue.unshift(prev);
    this.stopCurrent(); // 先收掉当前曲，playNext 就不会把它再记入历史
    await this.playNext();
  }

  /** 暂停：停住发帧节拍，听众侧静音挂起；缓冲由背压自动扼住。 */
  pause(): void {
    if (this.current) {
      this.paused = true;
    }
  }

  resume(): void {
    this.paused = false;
    this.nextFrameAt = Date.now(); // 重置节拍，防止恢复瞬间追帧爆发
  }

  /** 进程退出前的收尾：正在播的歌（含还在取直链路上的）塞回队首并落盘，重启后可从这里继续。 */
  shutdown(): void {
    const inFlight = this.current ?? this.fetching;
    if (inFlight) {
      this.queue.unshift(inFlight);
      this.persistQueue();
    }
    this.stopCurrent();
  }

  stopAll(): void {
    this.queue = [];
    this.persistQueue();
    this.notice = null;
    this.paused = false;
    this.stopCurrent();
    void this.ts.clearAvatar().catch(() => {});
    void this.ts.setNowPlaying(null).catch(() => {});
  }

  private async playNext(): Promise<void> {
    if (this.current) {
      this.history.push(this.current);
      if (this.history.length > HISTORY_MAX) {
        this.history.shift();
      }
    }
    this.stopCurrent(); // 内部 session++，在途的旧切歌自此作废
    this.paused = false;
    const track = this.queue.shift();
    this.persistQueue();
    if (!track) {
      void this.ts.clearAvatar().catch(() => {});
      void this.ts.setNowPlaying(null).catch(() => {});
      return;
    }
    const session = this.session;
    this.switchPending = true;
    this.fetching = track;
    // 下载由 Node 完成再喂给 ffmpeg 解码:静态编译的 ffmpeg
    // 在部分 Linux 上一走网络(DNS)就段错误,不能让它自己拉流
    let body: ReadableStream<Uint8Array>;
    try {
      const url = await withTimeout(streamUrl(track.id), SWITCH_STEP_TIMEOUT_MS, "获取播放地址");
      // 手动控制的 AbortController:只管"响应头迟迟不来",头到了就撤销,
      // 不能用 AbortSignal.timeout——它会连正文下载一起掐断
      const ctrl = new AbortController();
      const headerTimer = setTimeout(() => ctrl.abort(), SWITCH_STEP_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, { signal: ctrl.signal });
      } finally {
        clearTimeout(headerTimer);
      }
      if (!res.ok || !res.body) {
        throw new Error(`音源响应异常(HTTP ${res.status})`);
      }
      body = res.body;
    } catch (err) {
      if (session !== this.session) {
        return; // 取直链期间已被更晚的切歌/停止取代，静默退场
      }
      this.switchPending = false;
      console.error(`「${track.name}」${(err as Error).message}，跳到下一首`);
      this.notice = `「${track.name}」${(err as Error).message}，已跳过`;
      return this.playNext();
    }
    if (session !== this.session) {
      void body.cancel().catch(() => {}); // 管线已作废，退掉连接，绝不落地
      return;
    }
    this.switchPending = false;
    this.fetching = null;
    this.notice = null;
    this.current = track;
    this.startFfmpeg(body, session);
    void this.updateCover(track);
    void this.ts.setNowPlaying(track.name).catch(() => {});
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

  private startFfmpeg(source: ReadableStream<Uint8Array>, session: number): void {
    // 防御：任何情况下都不允许两条管线并存（正常路径 stopCurrent 已清过，这里兜底）
    if (this.pump) {
      clearInterval(this.pump);
      this.pump = null;
    }
    this.ffmpeg?.kill("SIGKILL");
    this.download?.destroy();
    this.prebuffer?.destroy();
    this.pcmBuffer = Buffer.alloc(0);
    this.playedFrames = 0;
    this.ffmpegDone = false;
    this.stalledSince = 0;
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
    // 整首歌先全速拉进内存（大水位 PassThrough），ffmpeg 从内存慢慢消化。
    // 若让网络连接跟着解码节奏细水长流，闲置几分钟会被 CDN 掐断（表现为放到一半"断流跳歌"）
    const prebuffer = new PassThrough({ highWaterMark: PREBUFFER_BYTES });
    this.prebuffer = prebuffer;
    prebuffer.on("error", () => {});
    ff.stdin!.on("error", () => {}); // 切歌 kill ffmpeg 后的 EPIPE
    download.pipe(prebuffer).pipe(ff.stdin!);

    ff.stdout!.on("data", (chunk: Buffer) => {
      this.pcmBuffer = Buffer.concat([this.pcmBuffer, chunk]);
      // 简单背压：PCM 缓冲超过 5 秒就暂停解码（压缩流仍在 prebuffer 里全速下载）
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
    // 帧泵闭包里带上自己的代际:代际过期就自毁,泄漏的旧泵绝无机会再碰共享状态
    const pump = setInterval(() => {
      if (session !== this.session) {
        clearInterval(pump);
        return;
      }
      this.pumpFrames();
    }, PUMP_INTERVAL_MS);
    this.pump = pump;
  }

  /** 按 20ms 节拍送帧，时间戳对齐避免累计漂移。 */
  private pumpFrames(): void {
    if (this.paused) {
      this.stalledSince = 0;
      return;
    }
    const now = Date.now();
    while (now >= this.nextFrameAt) {
      if (this.pcmBuffer.length >= PCM_FRAME_BYTES) {
        const pcm = this.pcmBuffer.subarray(0, PCM_FRAME_BYTES);
        this.pcmBuffer = this.pcmBuffer.subarray(PCM_FRAME_BYTES);
        if (this.pcmBuffer.length < PCM_FRAME_BYTES * 100) {
          this.ffmpeg?.stdout?.resume();
        }
        this.ts.sendOpusFrame(this.encoder.encode(this.applyGain(pcm)));
        this.playedFrames++;
        this.nextFrameAt += FRAME_MS;
        this.stalledSince = 0;
      } else if (this.ffmpegDone) {
        // 播完了，进下一首
        void this.playNext();
        return;
      } else {
        // 缓冲不足：短暂网络抖动就等下一轮；断流过久则视为卡死，弃曲跳下一首
        if (this.stalledSince === 0) {
          this.stalledSince = now;
        } else if (now - this.stalledSince > STALL_TIMEOUT_MS) {
          const name = this.current?.name ?? "";
          console.error(`「${name}」音频流断流超过 ${STALL_TIMEOUT_MS / 1000}s，跳到下一首`);
          this.notice = `「${name}」网络卡住，已自动跳到下一首`;
          void this.playNext();
          return;
        }
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
    this.session++; // 在途的切歌与残存帧泵自此全部作废
    this.switchPending = false;
    this.fetching = null;
    if (this.pump) {
      clearInterval(this.pump);
      this.pump = null;
    }
    this.download?.destroy();
    this.download = null;
    this.prebuffer?.destroy();
    this.prebuffer = null;
    this.ffmpeg?.kill("SIGKILL");
    this.ffmpeg = null;
    this.current = null;
    this.pcmBuffer = Buffer.alloc(0);
    this.playedFrames = 0;
  }
}
