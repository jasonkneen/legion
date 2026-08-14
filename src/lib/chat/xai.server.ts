const API_URL = "https://api.x.ai/v1/chat/completions";
const MODEL = "grok-4.6";

export type ProviderMessage = { role: "system" | "user" | "assistant"; content: string };

export function aiAvailable(): boolean {
  return Boolean(process.env.XAI_API_KEY);
}

export async function completeChat(
  messages: ProviderMessage[],
  opts: { maxTokens: number; temperature?: number },
): Promise<string> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error("AI is not available in this environment");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        stream: false,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature ?? 0.7,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`xAI API error ${res.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
    }

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return body.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("The seat took too long and was cut off.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
