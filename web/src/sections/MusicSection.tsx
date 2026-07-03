import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button, Chip, Divider, Input, Modal, ModalBody, ModalContent, ModalHeader, Slider,
} from "@heroui/react";
import { api, type BotStatus, type NeteaseProfile, type Track } from "../api";

const QUEUE_SHOWN = 8;

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function MusicSection({ notify }: { notify: (msg: string, isErr?: boolean) => void }) {
  const [bot, setBot] = useState<BotStatus | null>(null);
  const [botDown, setBotDown] = useState(false);
  const [profile, setProfile] = useState<NeteaseProfile | null>(null);
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [playlistInput, setPlaylistInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [volume, setVolume] = useState(60);
  const volDragging = useRef(false);
  // 扫码登录
  const [qr, setQr] = useState<{ key: string; qrimg: string } | null>(null);
  const [qrHint, setQrHint] = useState("");

  const refresh = useCallback(async () => {
    try {
      const s = await api<BotStatus>("/api/bot/status");
      setBot(s);
      setBotDown(false);
      if (!volDragging.current) setVolume(s.volume);
    } catch {
      setBot(null);
      setBotDown(true);
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    try {
      setProfile(await api<NeteaseProfile>("/api/bot/netease/profile"));
    } catch { /* Bot 不在线 */ }
  }, []);

  useEffect(() => {
    refresh();
    refreshProfile();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh, refreshProfile]);

  // 二维码轮询
  useEffect(() => {
    if (!qr) return;
    const t = setInterval(async () => {
      try {
        const r = await api<{ code: number; message: string }>("/api/bot/netease/qr/check", { key: qr.key });
        setQrHint(r.message);
        if (r.code === 803) {
          clearInterval(t);
          setTimeout(() => setQr(null), 1200);
          refreshProfile();
        } else if (r.code === 800) {
          clearInterval(t);
        }
      } catch (e) {
        clearInterval(t);
        setQrHint((e as Error).message);
      }
    }, 2000);
    return () => clearInterval(t);
  }, [qr, refreshProfile]);

  const startQr = async () => {
    try {
      const r = await api<{ key: string; qrimg: string }>("/api/bot/netease/qr/start", {});
      setQrHint("用网易云音乐 App 扫码");
      setQr(r);
    } catch (e) { notify((e as Error).message, true); }
  };

  const neteaseLogout = async () => {
    if (!confirm("退出网易云账号？VIP 歌曲将无法播放。")) return;
    try {
      await api("/api/bot/netease/logout", {});
      refreshProfile();
    } catch (e) { notify((e as Error).message, true); }
  };

  const doSearch = async () => {
    const kw = keyword.trim();
    if (!kw) return;
    setBusy(true);
    try {
      setResults(await api<Track[]>("/api/bot/search", { keyword: kw }));
    } catch (e) { notify((e as Error).message, true); }
    finally { setBusy(false); }
  };

  const play = async (t: Track) => {
    try {
      await api("/api/bot/play", t);
      notify(`已点播「${t.name}」`);
      refresh();
    } catch (e) { notify((e as Error).message, true); }
  };

  const loadPlaylist = async () => {
    const input = playlistInput.trim();
    if (!input) return;
    setBusy(true);
    notify("正在加载歌单…");
    try {
      const r = await api<{ message: string }>("/api/bot/playlist", { idOrUrl: input });
      notify(r.message);
      setPlaylistInput("");
      refresh();
    } catch (e) { notify((e as Error).message, true); }
    finally { setBusy(false); }
  };

  const simple = (path: string) => async () => {
    try {
      await api(path, {});
      refresh();
    } catch (e) { notify((e as Error).message, true); }
  };

  const setVol = async (v: number) => {
    volDragging.current = false;
    try { await api("/api/bot/volume", { value: v }); }
    catch (e) { notify((e as Error).message, true); }
  };

  return (
    <>
      <Divider />
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-small font-semibold text-default-500">点歌台</h2>
          {botDown
            ? <Chip size="sm" color="default" variant="dot">未运行</Chip>
            : bot?.connected
              ? <Chip size="sm" color="success" variant="dot">在线</Chip>
              : <Chip size="sm" color="warning" variant="dot">已启动，未连上服务器</Chip>}
        </div>

        {bot && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-small text-default-500">
                网易云账号：{profile?.loggedIn
                  ? `${profile.nickname}${profile.vip ? "（VIP）" : "（普通账号）"}`
                  : "未登录（只能播放免费歌曲）"}
              </span>
              {profile?.loggedIn
                ? <Button size="sm" variant="bordered" onPress={neteaseLogout}>退出账号</Button>
                : <Button size="sm" variant="bordered" color="primary" onPress={startQr}>扫码登录</Button>}
            </div>

            <div className="flex items-center justify-between">
              <span className="flex-1">
                {bot.current ? `♪ ${bot.current.name} - ${bot.current.artist}` : "没有正在播放的歌曲"}
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="bordered" onPress={simple("/api/bot/skip")}>切歌</Button>
                <Button size="sm" variant="bordered" color="danger" onPress={simple("/api/bot/stop")}>停止</Button>
              </div>
            </div>

            <Slider size="sm" label="音量" minValue={0} maxValue={100} step={5}
              value={volume}
              onChange={(v) => { volDragging.current = true; setVolume(v as number); }}
              onChangeEnd={(v) => setVol(v as number)}
              className="max-w-full" />

            {bot.queue.length > 0 && (
              <div className="flex flex-col gap-1">
                {bot.queue.slice(0, QUEUE_SHOWN).map((t, i) => (
                  <p key={`${t.id}-${i}`} className="text-small text-default-500 px-1">
                    {i + 1}. {t.name} - {t.artist}
                  </p>
                ))}
                {bot.queue.length > QUEUE_SHOWN && (
                  <p className="text-tiny text-default-400 px-1">
                    …队列中还有 {bot.queue.length - QUEUE_SHOWN} 首，共 {bot.queue.length} 首
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <Input size="sm" placeholder="搜索歌曲（网易云）" maxLength={60} value={keyword}
                onValueChange={setKeyword} onKeyDown={(e) => e.key === "Enter" && doSearch()} />
              <Button size="sm" color="primary" isLoading={busy} onPress={doSearch}>搜索</Button>
            </div>
            {results.map((t) => (
              <div key={t.id} className="flex items-center justify-between rounded-medium px-3 py-1.5 hover:bg-default-100">
                <span className="flex-1 break-all">{t.name} - {t.artist}</span>
                <span className="text-tiny text-default-500 mx-3">{fmtDuration(t.durationMs)}</span>
                <Button size="sm" color="primary" variant="flat" onPress={() => play(t)}>点播</Button>
              </div>
            ))}

            <div className="flex gap-2">
              <Input size="sm" placeholder="粘贴网易云歌单链接或 ID，整单播放" maxLength={200}
                value={playlistInput} onValueChange={setPlaylistInput}
                onKeyDown={(e) => e.key === "Enter" && loadPlaylist()} />
              <Button size="sm" color="primary" isLoading={busy} onPress={loadPlaylist}>播放歌单</Button>
              <Button size="sm" variant="bordered" onPress={simple("/api/bot/shuffle")}>打乱队列</Button>
            </div>
          </>
        )}
      </section>

      <Modal isOpen={qr !== null} onClose={() => setQr(null)} size="sm">
        <ModalContent>
          <ModalHeader>网易云扫码登录</ModalHeader>
          <ModalBody className="items-center pb-6 gap-3">
            {qr && <img src={qr.qrimg} alt="网易云登录二维码" className="w-44 h-44 rounded-medium" />}
            <p className="text-small text-default-500">{qrHint}</p>
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
}
