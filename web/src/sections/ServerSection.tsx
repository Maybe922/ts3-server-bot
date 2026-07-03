import { useState } from "react";
import { Button, Checkbox, Chip, Link, Snippet } from "@heroui/react";
import { api, type PanelStatus } from "../api";

function StatusChip({ s }: { s: PanelStatus }) {
  if (!s.serverInstalled) return <Chip color="warning" variant="dot">未安装</Chip>;
  return s.serverRunning
    ? <Chip color="success" variant="dot">运行中 (v{s.serverVersion})</Chip>
    : <Chip color="default" variant="dot">已停止 (v{s.serverVersion})</Chip>;
}

export function ServerSection({ status, onChanged, notify }: {
  status: PanelStatus;
  onChanged: () => void;
  notify: (msg: string, isErr?: boolean) => void;
}) {
  const [eula, setEula] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (path: string, pending: string) => {
    setBusy(true);
    notify(pending);
    try {
      const r = await api<{ message: string }>(path, {
        ...(path.endsWith("install") ? { acceptLicense: eula } : {}),
      });
      notify(r.message);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-default-500">TS3 服务器</span>
        <StatusChip s={status} />
      </div>

      {!status.serverInstalled && (
        <div className="flex flex-col gap-3">
          <Checkbox size="sm" isSelected={eula} onValueChange={setEula}>
            <span className="text-small text-default-500">
              我已阅读并同意{" "}
              <Link size="sm" href="https://www.teamspeak.com/en/privacy-and-terms/" isExternal>
                TeamSpeak 许可协议
              </Link>
              （安装包内 LICENSE 文件为准）
            </span>
          </Checkbox>
          <Button color="primary" isDisabled={!eula} isLoading={busy}
            onPress={() => run("/api/server/install", "正在从官方源下载安装（约 10MB）…")}>
            下载并安装 TS3 服务器
          </Button>
        </div>
      )}
      {status.serverInstalled && !status.serverRunning && (
        <Button color="primary" isLoading={busy} onPress={() => run("/api/server/start", "正在启动…")}>
          启动服务器
        </Button>
      )}
      {status.serverInstalled && status.serverRunning && (
        <Button variant="bordered" color="danger" isLoading={busy}
          onPress={() => run("/api/server/stop", "正在停止…")}>
          停止服务器
        </Button>
      )}

      {status.credentials && (
        <div className="rounded-large border border-default-200 p-4 flex flex-col gap-2">
          <p className="text-small font-semibold text-warning">⚠ 管理凭据（请妥善保存）</p>
          <div className="flex flex-col gap-1 text-small">
            <span className="text-default-500">连接地址</span>
            <Snippet symbol="" size="sm">{`${location.hostname}:9987`}</Snippet>
            <span className="text-default-500">管理员密钥 Token</span>
            <Snippet symbol="" size="sm" className="max-w-full overflow-x-auto">
              {status.credentials.adminToken || "（启动后生成）"}
            </Snippet>
            <span className="text-default-500">Query 账号</span>
            <Snippet symbol="" size="sm">
              {`${status.credentials.queryUser} / ${status.credentials.queryPassword}`}
            </Snippet>
          </div>
        </div>
      )}
    </section>
  );
}
