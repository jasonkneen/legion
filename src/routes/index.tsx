import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { EmptyChamber } from "@/components/empty-chamber";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { user, isPending } = useCurrentUserState();

  if (isPending) {
    return (
      <div className="flex h-dvh bg-bg">
        <div className="hidden w-64 border-r border-border bg-bg-elevated md:block" />
        <div className="flex-1 animate-pulse bg-bg" />
      </div>
    );
  }
  if (!user) return <RedirectToSignIn />;

  return (
    <AppShell>
      <EmptyChamber />
    </AppShell>
  );
}
