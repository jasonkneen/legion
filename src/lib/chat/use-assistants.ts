import { useCallback, useEffect, useState } from "react";
import { listAssistants } from "./assistant-actions";
import type { StoredAssistant } from "@/lib/models";

export function useAssistants() {
  const [assistants, setAssistants] = useState<StoredAssistant[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await listAssistants();
      setAssistants(rows);
    } catch {
      setAssistants((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUpdate = () => void refresh();
    window.addEventListener("chamber:assistants", onUpdate);
    return () => window.removeEventListener("chamber:assistants", onUpdate);
  }, [refresh]);

  return {
    assistants: assistants ?? [],
    loading: assistants === null,
    setAssistants,
    refresh,
  };
}
