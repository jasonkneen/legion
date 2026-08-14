import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import type { StoredAssistant } from "@/lib/models";

export const listAssistants = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<StoredAssistant[]> => {
    const { listForUser } = await import("./assistants.server");
    return listForUser(context.userId);
  });

export const saveAssistant = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      id?: string;
      name: string;
      handle: string;
      modelId: string;
      role: string;
      blurb: string;
      tag: string;
    }) => input,
  )
  .handler(async ({ context, data }): Promise<StoredAssistant[]> => {
    const { saveForUser } = await import("./assistants.server");
    return saveForUser(context.userId, data);
  });

export const deleteAssistant = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string }) => input)
  .handler(async ({ context, data }): Promise<StoredAssistant[]> => {
    const { removeForUser } = await import("./assistants.server");
    return removeForUser(context.userId, data.id);
  });
