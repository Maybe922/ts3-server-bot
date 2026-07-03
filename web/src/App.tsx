import { useCallback, useEffect, useState } from "react";
import { Button, Card, CardBody, CardHeader, Divider } from "@heroui/react";
import { api, UnauthorizedError, type AuthState, type PanelStatus } from "./api";
import { ThemeToggle, useTheme } from "./theme";
import { LoginView, SetupView } from "./sections/AuthViews";
import { ServerSection } from "./sections/ServerSection";
import { OpsSection } from "./sections/OpsSection";
import { MusicSection } from "./sections/MusicSection";

type View = "loading" | "setup" | "login" | "main";

export default function App() {
  const { dark, setDark } = useTheme();
  const [view, setView] = useState<View>("loading");
  const [status, setStatus] = useState<PanelStatus | null>(null);
  const [msg, setMsg] = useState<{ text: string; isErr: boolean } | null>(null);

  const notify = useCallback((text: string, isErr = false) => {
    setMsg({ text, isErr });
  }, []);

  const boot = useCallback(async () => {
    try {
      const s = await api<AuthState>("/api/auth/state");
      setView(!s.passwordSet ? "setup" : s.loggedIn ? "main" : "login");
    } catch {
      setView("login");
    }
  }, []);

  useEffect(() => { boot(); }, [boot]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api<PanelStatus>("/api/status"));
    } catch (e) {
      if (e instanceof UnauthorizedError) setView("login");
    }
  }, []);

  useEffect(() => {
    if (view !== "main") return;
    refreshStatus();
    const t = setInterval(refreshStatus, 5000);
    return () => clearInterval(t);
  }, [view, refreshStatus]);

  const logout = async () => {
    await api("/api/auth/logout", {}).catch(() => {});
    setView("login");
  };

  return (
    <main className="min-h-dvh grid place-items-center bg-background text-foreground p-4">
      {view === "setup" && <SetupView onDone={() => setView("main")} />}
      {view === "login" && <LoginView onDone={() => setView("main")} />}
      {view === "main" && (
        <Card className="w-[44rem] max-w-[96vw] p-4 my-8">
          <CardHeader className="flex items-start justify-between">
            <div>
              <h1 className="text-xl font-bold">
                TS3 <span className="text-primary">Panel</span>
              </h1>
              <p className="text-small text-default-500">TeamSpeak 3 一键部署与管理</p>
            </div>
            <div className="flex items-center gap-3">
              <ThemeToggle dark={dark} setDark={setDark} />
              <Button size="sm" variant="light" onPress={logout}>退出登录</Button>
            </div>
          </CardHeader>
          <CardBody className="gap-5">
            <div className="flex items-center justify-between">
              <span className="text-default-500">面板版本</span>
              <span>{status?.panelVersion ?? "…"}</span>
            </div>
            {status && (
              <ServerSection status={status} onChanged={refreshStatus} notify={notify} />
            )}
            {msg && (
              <p className={`text-small ${msg.isErr ? "text-danger" : "text-default-500"}`}>{msg.text}</p>
            )}
            {status?.serverRunning && <OpsSection notify={notify} />}
            <MusicSection notify={notify} />
            <Divider />
            <p className="text-tiny text-default-400 text-center">
              TS3 Panel · 开源的 TeamSpeak 一键部署与管理面板
            </p>
          </CardBody>
        </Card>
      )}
    </main>
  );
}
