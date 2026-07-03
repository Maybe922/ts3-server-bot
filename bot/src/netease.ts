// 网易云音源：搜索 + 取播放直链 + 扫码登录。
// 未登录只能播免费曲库；扫码登录后按账号权益（如黑胶 VIP）取直链。
import api from "NeteaseCloudMusicApi";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config.js";

const COOKIE_FILE = join(dataDir, "netease-cookie.txt");

let cookie = existsSync(COOKIE_FILE) ? readFileSync(COOKIE_FILE, "utf8").trim() : "";

export interface Track {
  id: number;
  name: string;
  artist: string;
  durationMs: number;
}

export async function search(keyword: string, limit = 10): Promise<Track[]> {
  const res = await api.cloudsearch({ keywords: keyword, limit, cookie });
  const body = res.body as any;
  const songs = body?.result?.songs ?? [];
  return songs.map((s: any) => ({
    id: s.id,
    name: s.name,
    artist: (s.ar ?? []).map((a: any) => a.name).join("/") || "未知",
    durationMs: s.dt ?? 0,
  }));
}

export async function streamUrl(id: number): Promise<string> {
  const res = await api.song_url_v1({ id, level: "exhigh", cookie } as any);
  const body = res.body as any;
  const url: string | null = body?.data?.[0]?.url ?? null;
  if (!url) {
    throw new Error(cookie ? "无法获取播放地址（可能超出账号权益或已下架）" : "无法获取播放地址（VIP 歌曲需先扫码登录）");
  }
  return url;
}

// —— 扫码登录 ——

export async function qrStart(): Promise<{ key: string; qrimg: string }> {
  const keyRes = await api.login_qr_key({});
  const key = (keyRes.body as any)?.data?.unikey;
  if (!key) throw new Error("获取二维码 key 失败");
  const qrRes = await api.login_qr_create({ key, qrimg: true } as any);
  const qrimg = (qrRes.body as any)?.data?.qrimg;
  if (!qrimg) throw new Error("生成二维码失败");
  return { key, qrimg };
}

/** 轮询扫码状态。code: 800 过期 / 801 待扫码 / 802 待确认 / 803 成功。 */
export async function qrCheck(key: string): Promise<{ code: number; message: string }> {
  const res = await api.login_qr_check({ key });
  const body = res.body as any;
  const code = Number(body?.code ?? 0);
  if (code === 803 && body.cookie) {
    cookie = String(body.cookie);
    writeFileSync(COOKIE_FILE, cookie, { mode: 0o600 });
  }
  const messages: Record<number, string> = {
    800: "二维码已过期，请重新生成",
    801: "等待扫码",
    802: "已扫码，请在手机上确认",
    803: "登录成功",
  };
  return { code, message: messages[code] ?? `未知状态 ${code}` };
}

export async function profile(): Promise<{ loggedIn: boolean; nickname?: string; vip?: boolean }> {
  if (!cookie) return { loggedIn: false };
  const res = await api.login_status({ cookie });
  const data = (res.body as any)?.data;
  const prof = data?.profile;
  if (!prof) return { loggedIn: false };
  return {
    loggedIn: true,
    nickname: prof.nickname ?? "未知用户",
    vip: (prof.vipType ?? 0) > 0 || (data?.account?.vipType ?? 0) > 0,
  };
}

export function logout(): void {
  cookie = "";
  rmSync(COOKIE_FILE, { force: true });
}
