// 统一 API 客户端：面板后端返回 {success, data, error} 信封。
// 401 时抛出特殊错误，由 App 捕获切回登录页。

export class UnauthorizedError extends Error {
  constructor() {
    super("未登录");
  }
}

export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body !== undefined
    ? { method: "POST", body: JSON.stringify(body) }
    : {});
  if (res.status === 401) throw new UnauthorizedError();
  const json = await res.json();
  if (!json.success) throw new Error(json.error || "请求失败");
  return json.data as T;
}

// —— 类型 ——

export interface AuthState {
  passwordSet: boolean;
  loggedIn: boolean;
}

export interface Credentials {
  queryUser: string;
  queryPassword: string;
  adminToken: string;
}

export interface PanelStatus {
  panelVersion: string;
  serverVersion: string;
  serverInstalled: boolean;
  serverRunning: boolean;
  credentials?: Credentials;
}

export interface Overview {
  name: string;
  clientsOnline: number;
  maxClients: number;
  uptimeSeconds: number;
}

export interface Channel {
  id: number;
  parentId: number;
  name: string;
  clients: number;
}

export interface OnlineClient {
  id: number;
  channelId: number;
  nickname: string;
}

export interface Track {
  id: number;
  name: string;
  artist: string;
  durationMs: number;
}

export interface BotStatus {
  connected: boolean;
  playing: boolean;
  current: Track | null;
  queue: Track[];
  volume: number;
}

export interface NeteaseProfile {
  loggedIn: boolean;
  nickname?: string;
  vip?: boolean;
}
