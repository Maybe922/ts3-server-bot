import { useState } from "react";
import { Button, Card, CardBody, CardHeader, Input } from "@heroui/react";
import { api } from "../api";

function Brand() {
  return (
    <div>
      <h1 className="text-xl font-bold">
        TS3 <span className="text-primary">Panel</span>
      </h1>
      <p className="text-small text-default-500">TeamSpeak 3 一键部署与管理</p>
    </div>
  );
}

export function SetupView({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (pw !== pw2) return setErr("两次输入不一致");
    setBusy(true);
    setErr("");
    try {
      await api("/api/auth/setup", { password: pw });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="w-[26rem] max-w-[94vw] p-4">
      <CardHeader><Brand /></CardHeader>
      <CardBody className="gap-4">
        <p className="text-small text-default-500">欢迎！首次使用请设置面板管理密码</p>
        <Input type="password" label="设置密码" description="至少 8 位" value={pw} onValueChange={setPw} />
        <Input type="password" label="再输入一次" value={pw2} onValueChange={setPw2}
          onKeyDown={(e) => e.key === "Enter" && submit()} />
        <Button color="primary" isLoading={busy} onPress={submit}>设置并进入面板</Button>
        {err && <p className="text-small text-danger">{err}</p>}
      </CardBody>
    </Card>
  );
}

export function LoginView({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      await api("/api/auth/login", { password: pw });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="w-[26rem] max-w-[94vw] p-4">
      <CardHeader><Brand /></CardHeader>
      <CardBody className="gap-4">
        <Input type="password" label="面板管理密码" value={pw} onValueChange={setPw}
          onKeyDown={(e) => e.key === "Enter" && submit()} autoFocus />
        <Button color="primary" isLoading={busy} onPress={submit}>登录</Button>
        {err && <p className="text-small text-danger">{err}</p>}
      </CardBody>
    </Card>
  );
}
