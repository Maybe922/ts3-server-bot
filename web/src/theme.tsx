import { useEffect, useState } from "react";
import { Switch } from "@heroui/react";

const STORAGE_KEY = "ts3panel-theme";

export function useTheme() {
  const [dark, setDark] = useState(() => localStorage.getItem(STORAGE_KEY) !== "light");
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.classList.toggle("light", !dark);
    localStorage.setItem(STORAGE_KEY, dark ? "dark" : "light");
  }, [dark]);
  return { dark, setDark };
}

export function ThemeToggle({ dark, setDark }: { dark: boolean; setDark: (v: boolean) => void }) {
  return (
    <Switch
      size="sm"
      isSelected={dark}
      onValueChange={setDark}
      startContent={<span>🌙</span>}
      endContent={<span>☀️</span>}
      aria-label="切换深色/浅色主题"
    >
      <span className="text-small text-default-500">{dark ? "深色" : "浅色"}</span>
    </Switch>
  );
}
