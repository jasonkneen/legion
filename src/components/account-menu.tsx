import { useCurrentUser, useCurrentUserState } from "@/lib/auth/use-current-user";
import { authEnabled, signOut } from "@/lib/auth/client";
import { Link } from "@tanstack/react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function AccountSlot({ compact = false }: { compact?: boolean }) {
  const { user, isPending } = useCurrentUserState();
  if (isPending) {
    return <div className={cn("animate-pulse rounded-full bg-bg-subtle", compact ? "size-8" : "h-10 w-full")} />;
  }
  if (!user) {
    return (
      <Link
        to="/login"
        className="inline-flex h-10 items-center justify-center rounded-md border border-border px-3 text-sm font-medium hover:bg-bg-subtle"
      >
        Sign in
      </Link>
    );
  }
  return <AccountMenu compact={compact} />;
}

function AccountMenu({ compact }: { compact: boolean }) {
  const user = useCurrentUser();
  if (!user) return null;
  const label = user.displayName ?? user.primaryEmail ?? "Account";
  const initial = label.charAt(0).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left hover:bg-bg-subtle",
          compact && "w-auto px-0",
        )}
      >
        {user.profileImageUrl ? (
          <img src={user.profileImageUrl} alt="" className="size-8 rounded-full object-cover" />
        ) : (
          <span className="grid size-8 place-items-center rounded-full bg-bg-subtle text-xs font-medium">
            {initial}
          </span>
        )}
        {!compact && <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={compact ? "end" : "start"} className="w-56">
        <DropdownMenuLabel className="truncate">{user.primaryEmail ?? label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings">API keys & settings</Link>
        </DropdownMenuItem>
        {authEnabled && (
          <DropdownMenuItem onSelect={() => void signOut()}>Sign out</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
