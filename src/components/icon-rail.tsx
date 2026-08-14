import { Link } from "@tanstack/react-router";
import { Compass, MessageSquare, Moon, Settings, Sun } from "lucide-react";
import { BrandMark } from "@/components/brand";
import { AccountSlot } from "@/components/account-menu";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export function IconRail({
  section,
  theme,
  onToggleTheme,
}: {
  section: "chat" | "discover" | "settings";
  theme: Theme;
  onToggleTheme: () => void;
}) {
  return (
    <nav className="flex h-full w-14 shrink-0 flex-col items-center border-r border-border bg-bg-elevated py-3">
      <Link to="/" aria-label="Legion home" className="mb-4">
        <BrandMark className="size-8" />
      </Link>

      <RailLink to="/" active={section === "chat"} label="Chat">
        <MessageSquare className="size-4" />
      </RailLink>
      <RailLink to="/discover" active={section === "discover"} label="Discover">
        <Compass className="size-4" />
      </RailLink>

      <div className="mt-auto flex flex-col items-center gap-1">
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label="Toggle theme"
          className="grid size-10 place-items-center rounded-xl text-fg-muted hover:bg-bg-subtle hover:text-fg"
        >
          {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
        <RailLink to="/settings" active={section === "settings"} label="Settings">
          <Settings className="size-4" />
        </RailLink>
        <div className="mt-1">
          <AccountSlot compact />
        </div>
      </div>
    </nav>
  );
}

function RailLink({
  to,
  active,
  label,
  children,
}: {
  to: "/discover" | "/settings" | "/";
  active: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      aria-label={label}
      className={cn(
        "grid size-10 place-items-center rounded-xl",
        active ? "bg-bg-subtle text-fg" : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
      )}
    >
      {children}
    </Link>
  );
}
