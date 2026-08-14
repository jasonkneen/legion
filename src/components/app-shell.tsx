import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { toast } from "sonner";
import { Sidebar } from "@/components/sidebar";
import { IconRail } from "@/components/icon-rail";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { createConversation, deleteConversation, listConversations } from "@/lib/chat/actions";
import type { Conversation } from "@/lib/chat/types";
import { useAssistants } from "@/lib/chat/use-assistants";
import { ASSISTANTS, SEAT_PRESETS } from "@/lib/models";
import { applyTheme, readTheme, type Theme } from "@/lib/theme";

export function AppShell({
  children,
  activeId,
  section = "chat",
}: {
  children: ReactNode;
  activeId?: string;
  section?: "chat" | "discover" | "settings";
}) {
  const navigate = useNavigate();
  const { assistants } = useAssistants();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [creating, setCreating] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const next = readTheme();
    setTheme(next);
    applyTheme(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const rows = await listConversations();
      setConversations(rows);
    } catch {
      // signed-out / still loading handled by parent
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUpdate = () => void refresh();
    window.addEventListener("chamber:updated", onUpdate);
    return () => window.removeEventListener("chamber:updated", onUpdate);
  }, [refresh]);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  }

  async function startAssistant(id: string) {
    if (creating) return;
    const assistant = assistants.find((a) => a.id === id) ?? ASSISTANTS.find((a) => a.id === id);
    const preset = SEAT_PRESETS.find((p) => p.id === id);
    if (!assistant && !preset) return;
    setCreating(true);
    try {
      const seats = preset
        ? preset.seats.map((s) => ({
            modelId: s.modelId,
            displayName: s.name,
            handle: s.handle,
            role: s.role,
          }))
        : [
            {
              modelId: assistant!.modelId,
              displayName: assistant!.name,
              handle: assistant!.handle,
              role: assistant!.role,
            },
          ];
      const created = await createConversation({
        data: {
          title: preset?.label ?? assistant?.name ?? "New chat",
          seats,
        },
      });
      setConversations((prev) => [created.conversation, ...prev]);
      setMobileOpen(false);
      await navigate({ to: "/c/$id", params: { id: created.conversation.id } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start chat");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    await deleteConversation({ data: id });
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) await navigate({ to: "/" });
  }

  const side = (
    <Sidebar
      conversations={conversations}
      activeId={activeId}
      assistants={assistants}
      onNew={() => void startAssistant("just-chat")}
      onOpenAssistant={(id) => void startAssistant(id)}
      onDelete={(id) => void handleDelete(id)}
      creating={creating}
    />
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-fg">
      <div className="hidden md:flex">
        <IconRail section={section} theme={theme} onToggleTheme={toggleTheme} />
        {section === "chat" && (
          <aside className="w-64 shrink-0 border-r border-border bg-bg-elevated">{side}</aside>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border px-3 py-2 md:hidden">
          <Button variant="ghost" size="icon-sm" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu />
          </Button>
          <span className="text-sm font-semibold">Legion</span>
          <span className="size-8" />
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="flex w-[min(100%,22rem)] flex-row gap-0 p-0">
          <IconRail section={section} theme={theme} onToggleTheme={toggleTheme} />
          <div className="min-w-0 flex-1">{side}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
