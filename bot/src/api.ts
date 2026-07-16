// 控制 API：只绑本机回环，供面板代理调用。Bearer Token 鉴权。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { search, playlist, qrStart, qrCheck, profile, logout } from "./netease.js";
import type { Player } from "./player.js";
import type { TSClient } from "./ts-client.js";
import { saveConfig, type BotConfig } from "./config.js";

// 昵称上限 20 字符:TS 全名上限 30,给「♪歌名」留出空间
const NICKNAME_BASE_MAX = 20;

export function startAPI(config: BotConfig, ts: TSClient, player: Player): void {
  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      send(res, 500, { success: false, error: (err as Error).message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${config.apiToken}`) {
      return send(res, 401, { success: false, error: "未授权" });
    }
    const route = `${req.method} ${req.url?.split("?")[0]}`;
    switch (route) {
      case "GET /status":
        return send(res, 200, {
          success: true,
          data: {
            connected: ts.connected,
            connectFailures: ts.connectFailures,
            nickname: config.nickname,
            serverPasswordSet: config.serverPassword !== "",
            ...player.status(),
          },
        });
      case "POST /nickname": {
        const { name } = await body(req);
        const trimmed = String(name ?? "").trim();
        if (!trimmed || [...trimmed].length > NICKNAME_BASE_MAX) {
          return send(res, 400, { success: false, error: `昵称需为 1-${NICKNAME_BASE_MAX} 个字符` });
        }
        config.nickname = trimmed;
        // 在线则立即改名(播放中带歌名),离线则下次连接生效;先应用再落盘
        await ts.setNowPlaying(player.status().current?.name ?? null);
        saveConfig(config);
        return send(res, 200, { success: true, data: { message: `机器人已改名「${trimmed}」` } });
      }
      case "POST /serverpassword": {
        // TS 服务器的连接密码。守护循环每次重连现读 config，保存后下一轮重试（≤5s）即生效
        const { password } = await body(req);
        const pw = String(password ?? "");
        if (pw.length > 128) {
          return send(res, 400, { success: false, error: "密码过长" });
        }
        config.serverPassword = pw;
        saveConfig(config);
        return send(res, 200, {
          success: true,
          data: { message: pw ? "已保存服务器密码，机器人稍后自动重连" : "已清除服务器密码" },
        });
      }
      case "POST /search": {
        const { keyword, page } = await body(req);
        if (!keyword) return send(res, 400, { success: false, error: "缺少关键词" });
        const pageNum = Math.max(1, Math.floor(Number(page) || 1));
        const result = await search(String(keyword), pageNum);
        return send(res, 200, {
          success: true,
          data: { songs: result.tracks, page: pageNum, hasMore: result.hasMore },
        });
      }
      case "POST /play": {
        const { id, name, artist, durationMs } = await body(req);
        if (!id || !name) return send(res, 400, { success: false, error: "缺少歌曲信息" });
        await player.enqueue({ id: Number(id), name: String(name), artist: String(artist ?? ""), durationMs: Number(durationMs ?? 0) });
        return send(res, 200, { success: true, data: { message: "已加入队列" } });
      }
      case "POST /playlist": {
        const { idOrUrl, shuffle } = await body(req);
        if (!idOrUrl) return send(res, 400, { success: false, error: "缺少歌单链接或 ID" });
        const pl = await playlist(String(idOrUrl));
        await player.enqueueMany(pl.tracks);
        if (shuffle) player.shuffle();
        return send(res, 200, {
          success: true,
          data: { message: `已加入歌单「${pl.name}」共 ${pl.tracks.length} 首`, name: pl.name, added: pl.tracks.length },
        });
      }
      case "POST /remove": {
        const { index, id } = await body(req);
        const removed = player.remove(Number(index), Number(id));
        if (!removed) return send(res, 404, { success: false, error: "这首歌已不在队列中" });
        return send(res, 200, { success: true, data: { message: `已移除「${removed.name}」` } });
      }
      case "POST /shuffle":
        player.shuffle();
        return send(res, 200, { success: true, data: { message: "队列已打乱" } });
      case "POST /skip":
        await player.skip();
        return send(res, 200, { success: true, data: { message: "已切到下一首" } });
      case "POST /previous":
        await player.previous();
        return send(res, 200, { success: true, data: { message: "已回到上一首" } });
      case "POST /pause":
        player.pause();
        return send(res, 200, { success: true, data: { message: "已暂停" } });
      case "POST /resume":
        player.resume();
        return send(res, 200, { success: true, data: { message: "继续播放" } });
      case "POST /stop":
        player.stopAll();
        return send(res, 200, { success: true, data: { message: "已停止" } });
      case "POST /volume": {
        const { value } = await body(req);
        const vol = Math.max(0, Math.min(100, Number(value)));
        if (Number.isNaN(vol)) return send(res, 400, { success: false, error: "音量需为 0-100" });
        player.volume = vol;
        return send(res, 200, { success: true, data: { volume: vol } });
      }
      case "POST /netease/qr/start":
        return send(res, 200, { success: true, data: await qrStart() });
      case "POST /netease/qr/check": {
        const { key } = await body(req);
        if (!key) return send(res, 400, { success: false, error: "缺少 key" });
        return send(res, 200, { success: true, data: await qrCheck(String(key)) });
      }
      case "GET /netease/profile":
        return send(res, 200, { success: true, data: await profile() });
      case "POST /netease/logout":
        logout();
        return send(res, 200, { success: true, data: { message: "已退出网易云账号" } });
      default:
        return send(res, 404, { success: false, error: "未知接口" });
    }
  }

  server.listen(config.apiPort, "127.0.0.1", () => {
    console.log(`控制 API: http://127.0.0.1:${config.apiPort}`);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}
