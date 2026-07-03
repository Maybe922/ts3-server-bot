// 网易云音源：搜索 + 取播放直链。
// 免登录可播免费曲库；VIP 曲目 url 为空时明确报错。
import api from "NeteaseCloudMusicApi";

export interface Track {
  id: number;
  name: string;
  artist: string;
  durationMs: number;
}

export async function search(keyword: string, limit = 10): Promise<Track[]> {
  const res = await api.cloudsearch({ keywords: keyword, limit });
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
  const res = await api.song_url_v1({ id, level: "standard" } as any);
  const body = res.body as any;
  const url: string | null = body?.data?.[0]?.url ?? null;
  if (!url) {
    throw new Error("无法获取播放地址（可能是 VIP 专属或已下架）");
  }
  return url;
}
