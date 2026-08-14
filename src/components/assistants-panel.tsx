import { Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AssistantEditor } from "@/components/assistant-editor";
import { SeatAvatar } from "@/components/seat-avatar";
import { Button } from "@/components/ui/button";
import { deleteAssistant } from "@/lib/chat/assistant-actions";
import { useAssistants } from "@/lib/chat/use-assistants";
import { MODEL_BY_ID, type StoredAssistant } from "@/lib/models";

export function AssistantsPanel() {
  const { assistants, loading } = useAssistants();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<StoredAssistant | null>(null);

  async function remove(assistant: StoredAssistant) {
    try {
      await deleteAssistant({ data: { id: assistant.id } });
      window.dispatchEvent(new Event("chamber:assistants"));
      toast.success(assistant.builtin ? "Reset to default" : "Rank removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove");
    }
  }

  return (
    <section>
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Ranks</h2>
          <p className="mt-1 text-xs text-fg-subtle">
            Definitions we seat from Discover and the sidebar. Edit a built-in or add a rank.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setEditorOpen(true);
          }}
        >
          <Plus />
          New
        </Button>
      </div>

      {loading ? (
        <div className="mt-3 h-28 animate-pulse rounded-xl bg-bg-subtle" />
      ) : (
        <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-bg-elevated">
          {assistants.map((a) => {
            const model = MODEL_BY_ID[a.modelId];
            return (
              <li key={a.id} className="flex items-center gap-3 px-3 py-2.5">
                <SeatAvatar modelId={a.modelId} name={a.name} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{a.name}</div>
                  <div className="truncate text-xs text-fg-subtle">
                    @{a.handle} · {model.name}
                    {a.customized && a.builtin ? " · edited" : ""}
                    {!a.builtin ? " · yours" : ""}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${a.name}`}
                  onClick={() => {
                    setEditing(a);
                    setEditorOpen(true);
                  }}
                >
                  <Pencil />
                </Button>
                {(a.customized || !a.builtin) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={a.builtin ? `Reset ${a.name}` : `Delete ${a.name}`}
                    onClick={() => void remove(a)}
                  >
                    {a.builtin ? <RotateCcw /> : <Trash2 />}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <AssistantEditor open={editorOpen} onOpenChange={setEditorOpen} initial={editing} />
    </section>
  );
}
