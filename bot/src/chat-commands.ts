// 频道聊天点歌：进频道的任何人发「!点歌 歌名」等指令即可控制点歌，面板不再是唯一入口。
// 消息来路（频道/私聊/服务器聊天）在哪，回复就回哪；非指令消息一律静默忽略。
import type { TextMessage } from "@honeybbq/teamspeak-client";
import { search } from "./netease.js";
import type { Player } from "./player.js";
import type { TSClient } from "./ts-client.js";

// 同一用户两条指令的最小间隔：防手滑连发刷屏，也防触发服务器洪水保护
const COOLDOWN_MS = 2000;
// 队列预览条数：聊天消息有长度上限，刷太长也没人看
const QUEUE_PREVIEW = 5;
// 聊天点歌的队列上限：与歌单导入的 500 对齐，防多人刷指令把队列灌爆
const QUEUE_MAX = 500;

type Action = "play" | "skip" | "previous" | "pause" | "resume" | "queue" | "volume" | "help";

export interface ParsedCommand {
  action: Action;
  arg: string;
}

// 别名 → 动作。中文别名允许不加空格（「!点歌晴天」也认），英文别名要求词边界
const ALIASES: Array<[alias: string, action: Action]> = [
  ["点歌", "play"], ["dg", "play"], ["play", "play"],
  ["下一首", "skip"], ["跳过", "skip"], ["skip", "skip"], ["next", "skip"],
  ["上一首", "previous"], ["prev", "previous"],
  ["暂停", "pause"], ["pause", "pause"],
  ["继续", "resume"], ["resume", "resume"],
  ["队列", "queue"], ["queue", "queue"], ["list", "queue"],
  ["音量", "volume"], ["vol", "volume"], ["volume", "volume"],
  ["帮助", "help"], ["指令", "help"], ["help", "help"],
];

const HELP_TEXT = [
  "点歌指令（频道里直接发）：",
  "!点歌 歌名 — 搜索并加入队列",
  "!跳过 / !上一首 — 切歌",
  "!暂停 / !继续",
  "!队列 — 看正在播的和接下来的歌",
  "!音量 0-100",
].join("\n");

/** 解析一条聊天消息。支持半角 ! 和中文输入法的全角 ！，不是指令返回 null。 */
export function parseCommand(raw: string): ParsedCommand | null {
  const text = raw.trim();
  if (!text.startsWith("!") && !text.startsWith("！")) {
    return null;
  }
  const body = text.slice(1).trim();
  const lower = body.toLowerCase();
  for (const [alias, action] of ALIASES) {
    if (!lower.startsWith(alias)) {
      continue;
    }
    const rest = body.slice(alias.length);
    // 英文别名必须整词匹配，防止把「!playlist」当成「!play list」
    if (/^[a-z]+$/.test(alias) && rest !== "" && !rest.startsWith(" ")) {
      continue;
    }
    return { action, arg: rest.trim() };
  }
  return null;
}

export class ChatCommands {
  private player: Player;
  private ts: TSClient;
  private lastCommandAt = new Map<string, number>();

  constructor(player: Player, ts: TSClient) {
    this.player = player;
    this.ts = ts;
  }

  /** 入口：TSClient 每收到一条文本消息调用一次。永不抛出。 */
  async handle(msg: TextMessage): Promise<void> {
    const cmd = parseCommand(msg.message);
    if (!cmd || this.onCooldown(msg.invokerUID)) {
      return;
    }
    console.log(`聊天指令 [${msg.invokerName}] ${msg.message.trim()}`);
    try {
      const reply = await this.execute(cmd);
      await this.ts.reply(msg, reply);
    } catch (err) {
      await this.ts.reply(msg, `出错了：${(err as Error).message}`).catch(() => {});
    }
  }

  private onCooldown(uid: string): boolean {
    const now = Date.now();
    const last = this.lastCommandAt.get(uid) ?? 0;
    if (now - last < COOLDOWN_MS) {
      return true;
    }
    // 防 Map 无限膨胀：条目多了就清一轮已过期的
    if (this.lastCommandAt.size > 100) {
      for (const [key, at] of this.lastCommandAt) {
        if (now - at >= COOLDOWN_MS) {
          this.lastCommandAt.delete(key);
        }
      }
    }
    this.lastCommandAt.set(uid, now);
    return false;
  }

  private async execute(cmd: ParsedCommand): Promise<string> {
    switch (cmd.action) {
      case "play":
        return this.play(cmd.arg);
      case "skip":
        return this.skip();
      case "previous":
        return this.previous();
      case "pause":
        return this.pause();
      case "resume":
        return this.resume();
      case "queue":
        return this.queueSummary();
      case "volume":
        return this.setVolume(cmd.arg);
      case "help":
        return HELP_TEXT;
    }
  }

  private async play(keyword: string): Promise<string> {
    if (!keyword) {
      return "要点什么歌？发「!点歌 歌名」";
    }
    if (this.player.status().queue.length >= QUEUE_MAX) {
      return `队列已满（${QUEUE_MAX} 首），先消化消化吧`;
    }
    const { tracks } = await search(keyword, 1);
    const track = tracks[0];
    if (!track) {
      return `没搜到「${keyword}」，换个关键词试试`;
    }
    const wasIdle = !this.player.status().playing;
    await this.player.enqueue(track);
    const label = `「${track.name} - ${track.artist}」`;
    if (wasIdle) {
      return `即将播放 ${label}`;
    }
    return `已点 ${label}，排在第 ${this.player.status().queue.length} 位`;
  }

  private async skip(): Promise<string> {
    const before = this.player.status();
    if (!before.playing && before.queue.length === 0) {
      return "队列是空的，发「!点歌 歌名」点一首";
    }
    await this.player.skip();
    const cur = this.player.status().current;
    return cur ? `已切到「${cur.name} - ${cur.artist}」` : "队列播完了";
  }

  private async previous(): Promise<string> {
    if (!this.player.status().hasPrevious) {
      return "没有上一首了";
    }
    await this.player.previous();
    const cur = this.player.status().current;
    return cur ? `回到「${cur.name} - ${cur.artist}」` : "没有上一首了";
  }

  private pause(): string {
    if (!this.player.status().playing) {
      return "现在没在放歌";
    }
    this.player.pause();
    return "已暂停，发「!继续」恢复";
  }

  private resume(): string {
    const s = this.player.status();
    if (!s.playing) {
      return "现在没在放歌，发「!点歌 歌名」点一首";
    }
    if (!s.paused) {
      return "没有暂停，正在播放中";
    }
    this.player.resume();
    return "继续播放";
  }

  private queueSummary(): string {
    const s = this.player.status();
    const lines: string[] = [];
    if (s.current) {
      lines.push(`正在播：${s.current.name} - ${s.current.artist}${s.paused ? "（已暂停）" : ""}`);
    } else {
      lines.push("现在没在放歌");
    }
    if (s.queue.length === 0) {
      lines.push("队列是空的，发「!点歌 歌名」点一首");
    } else {
      s.queue.slice(0, QUEUE_PREVIEW).forEach((t, i) => {
        lines.push(`${i + 1}. ${t.name} - ${t.artist}`);
      });
      if (s.queue.length > QUEUE_PREVIEW) {
        lines.push(`…还有 ${s.queue.length - QUEUE_PREVIEW} 首没列出，队列共 ${s.queue.length} 首`);
      }
    }
    return lines.join("\n");
  }

  private setVolume(arg: string): string {
    const value = Number(arg);
    if (!arg || !Number.isInteger(value) || value < 0 || value > 100) {
      return `音量要 0-100 的整数，如「!音量 50」（当前 ${this.player.volume}）`;
    }
    this.player.volume = value;
    return `音量已调到 ${value}`;
  }
}
