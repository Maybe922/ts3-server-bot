import { useCallback, useEffect, useState } from "react";
import { Button, Divider, Input } from "@heroui/react";
import { api, type Channel, type OnlineClient, type Overview } from "../api";

function fmtUptime(sec: number): string {
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} 小时`;
  return `${(sec / 86400).toFixed(1)} 天`;
}

function Stat({ num, label }: { num: string | number; label: string }) {
  return (
    <div>
      <div className="text-2xl font-bold">{num}</div>
      <div className="text-tiny text-default-500">{label}</div>
    </div>
  );
}

export function OpsSection({ notify }: { notify: (msg: string, isErr?: boolean) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [clients, setClients] = useState<OnlineClient[]>([]);
  const [newChannel, setNewChannel] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [ov, chs, cls] = await Promise.all([
        api<Overview>("/api/ts/overview"),
        api<Channel[]>("/api/ts/channels"),
        api<OnlineClient[]>("/api/ts/clients"),
      ]);
      setOverview(ov);
      setChannels(chs);
      setClients(cls);
    } catch { /* 服务器未就绪时静默，由外层状态控制显隐 */ }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const rename = async () => {
    const name = prompt("新的服务器名称：", overview?.name ?? "");
    if (!name) return;
    try {
      await api("/api/ts/rename", { name });
      refresh();
    } catch (e) { notify((e as Error).message, true); }
  };

  const createChannel = async () => {
    const name = newChannel.trim();
    if (!name) return;
    try {
      await api("/api/ts/channels/create", { name });
      setNewChannel("");
      refresh();
    } catch (e) { notify((e as Error).message, true); }
  };

  const deleteChannel = async (ch: Channel) => {
    if (!confirm(`删除频道「${ch.name}」？`)) return;
    try {
      await api("/api/ts/channels/delete", { channelId: ch.id });
      refresh();
    } catch (e) { notify((e as Error).message, true); }
  };

  const kick = async (c: OnlineClient) => {
    if (!confirm(`把「${c.nickname}」踢出服务器？`)) return;
    try {
      await api("/api/ts/kick", { clientId: c.id, reason: "管理员操作" });
      refresh();
    } catch (e) { notify((e as Error).message, true); }
  };

  if (!overview) return null;

  return (
    <>
      <Divider />
      <section className="flex flex-col gap-3">
        <h2 className="text-small font-semibold text-default-500">服务器概览</h2>
        <div className="flex items-baseline gap-3">
          <strong className="text-lg">{overview.name}</strong>
          <Button size="sm" variant="light" onPress={rename}>改名</Button>
        </div>
        <div className="flex gap-8">
          <Stat num={overview.clientsOnline} label="在线人数" />
          <Stat num={overview.maxClients} label="人数上限" />
          <Stat num={fmtUptime(overview.uptimeSeconds)} label="运行时间" />
        </div>
      </section>

      <Divider />
      <section className="flex flex-col gap-2">
        <h2 className="text-small font-semibold text-default-500">频道</h2>
        {channels.map((ch) => (
          <div key={ch.id} className="flex items-center justify-between rounded-medium px-3 py-1.5 hover:bg-default-100">
            <span className="flex-1 break-all">{ch.name}</span>
            <span className="text-tiny text-default-500 mx-3">{ch.clients} 人</span>
            <Button size="sm" variant="bordered" color="danger" onPress={() => deleteChannel(ch)}>删除</Button>
          </div>
        ))}
        <div className="flex gap-2 mt-1">
          <Input size="sm" placeholder="新频道名称" maxLength={40} value={newChannel}
            onValueChange={setNewChannel} onKeyDown={(e) => e.key === "Enter" && createChannel()} />
          <Button size="sm" color="primary" onPress={createChannel}>创建</Button>
        </div>
      </section>

      <Divider />
      <section className="flex flex-col gap-2">
        <h2 className="text-small font-semibold text-default-500">在线用户</h2>
        {clients.length === 0 && <p className="text-small text-default-400 px-3">当前没有人在线</p>}
        {clients.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-medium px-3 py-1.5 hover:bg-default-100">
            <span className="flex-1 break-all">{c.nickname}</span>
            <span className="text-tiny text-default-500 mx-3">ID {c.id}</span>
            <Button size="sm" variant="bordered" color="danger" onPress={() => kick(c)}>踢出</Button>
          </div>
        ))}
      </section>
    </>
  );
}
