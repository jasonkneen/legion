export type ProviderId =
  | "xai"
  | "openai"
  | "codex"
  | "anthropic"
  | "google"
  | "deepseek"
  | "kimi"
  | "minimax"
  | "openrouter"
  | "groq"
  | "mistral"
  | "together"
  | "fireworks"
  | "perplexity"
  | "ollama"
  | "qwen"
  | "zhipu"
  | "github";

export type ProviderKind = "openai" | "anthropic" | "gemini" | "codex";
export type ProviderAuth = "key" | "oauth" | "both" | "none";

export type ProviderDef = {
  id: ProviderId;
  name: string;
  blurb: string;
  defaultModel: string;
  docsUrl: string;
  docsLabel: string;
  placeholder: string;
  kind: ProviderKind;
  baseUrl: string;
  auth: ProviderAuth;
  envVar?: string;
  featured?: boolean;
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: "xai",
    name: "xAI",
    blurb: "Grok 4.6 and other Grok seats.",
    defaultModel: "grok-4.6",
    docsUrl: "https://console.x.ai/",
    docsLabel: "console.x.ai",
    placeholder: "xai-…",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    auth: "key",
    envVar: "XAI_API_KEY",
    featured: true,
  },
  {
    id: "codex",
    name: "Codex",
    blurb: "ChatGPT / Codex app-server via subscription OAuth or an API key.",
    defaultModel: "gpt-5.6-codex",
    docsUrl: "https://developers.openai.com/codex/app-server",
    docsLabel: "Codex app-server",
    placeholder: "Paste access token or auth.json",
    kind: "codex",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    auth: "both",
    featured: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    blurb: "GPT-5.6 Sol and other Platform models (API key).",
    defaultModel: "gpt-5.6-sol",
    docsUrl: "https://platform.openai.com/api-keys",
    docsLabel: "platform.openai.com",
    placeholder: "sk-…",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    auth: "key",
    featured: true,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    blurb: "Claude seats. API key, or a Claude Agent / setup-token from `claude setup-token`.",
    defaultModel: "claude-sonnet-5",
    docsUrl: "https://code.claude.com/docs/en/agent-sdk/overview",
    docsLabel: "Agent SDK",
    placeholder: "sk-ant-… or sk-ant-oat01-…",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    auth: "both",
    featured: true,
  },
  {
    id: "google",
    name: "Google",
    blurb: "Gemini seats. API key from AI Studio — no public third-party OAuth.",
    defaultModel: "gemini-3.6-flash",
    docsUrl: "https://aistudio.google.com/apikey",
    docsLabel: "aistudio.google.com",
    placeholder: "AIza…",
    kind: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    auth: "key",
    featured: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    blurb: "DeepSeek seats.",
    defaultModel: "deepseek-chat",
    docsUrl: "https://platform.deepseek.com/api_keys",
    docsLabel: "platform.deepseek.com",
    placeholder: "sk-…",
    kind: "openai",
    baseUrl: "https://api.deepseek.com",
    auth: "key",
    featured: true,
  },
  {
    id: "kimi",
    name: "Moonshot",
    blurb: "Kimi seats.",
    defaultModel: "kimi-k2.6",
    docsUrl: "https://platform.moonshot.ai/console/api-keys",
    docsLabel: "platform.moonshot.ai",
    placeholder: "sk-…",
    kind: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    auth: "key",
    featured: true,
  },
  {
    id: "minimax",
    name: "MiniMax",
    blurb: "MiniMax seats.",
    defaultModel: "MiniMax-M3",
    docsUrl: "https://platform.minimax.io/",
    docsLabel: "platform.minimax.io",
    placeholder: "eyJ…",
    kind: "openai",
    baseUrl: "https://api.minimax.io/v1",
    auth: "key",
    featured: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    blurb: "One key for many models.",
    defaultModel: "openrouter/auto",
    docsUrl: "https://openrouter.ai/keys",
    docsLabel: "openrouter.ai",
    placeholder: "sk-or-…",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: "key",
  },
  {
    id: "groq",
    name: "Groq",
    blurb: "Fast inference.",
    defaultModel: "llama-3.3-70b-versatile",
    docsUrl: "https://console.groq.com/keys",
    docsLabel: "console.groq.com",
    placeholder: "gsk_…",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    auth: "key",
  },
  {
    id: "mistral",
    name: "Mistral",
    blurb: "Mistral and Mixtral models.",
    defaultModel: "mistral-large-latest",
    docsUrl: "https://console.mistral.ai/api-keys",
    docsLabel: "console.mistral.ai",
    placeholder: "…",
    kind: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    auth: "key",
  },
  {
    id: "together",
    name: "Together",
    blurb: "Open models, hosted.",
    defaultModel: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
    docsUrl: "https://api.together.xyz/",
    docsLabel: "together.ai",
    placeholder: "…",
    kind: "openai",
    baseUrl: "https://api.together.xyz/v1",
    auth: "key",
  },
  {
    id: "fireworks",
    name: "Fireworks",
    blurb: "Hosted open models.",
    defaultModel: "accounts/fireworks/models/llama-v3p1-70b-instruct",
    docsUrl: "https://fireworks.ai/account/api-keys",
    docsLabel: "fireworks.ai",
    placeholder: "…",
    kind: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    auth: "key",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    blurb: "Sonar search-backed answers.",
    defaultModel: "sonar-pro",
    docsUrl: "https://www.perplexity.ai/settings/api",
    docsLabel: "perplexity.ai",
    placeholder: "pplx-…",
    kind: "openai",
    baseUrl: "https://api.perplexity.ai",
    auth: "key",
  },
  {
    id: "ollama",
    name: "Ollama",
    blurb: "Local models. No key. Set the host if it is not on this machine.",
    defaultModel: "llama3.2",
    docsUrl: "https://ollama.com/",
    docsLabel: "ollama.com",
    placeholder: "(optional)",
    kind: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    auth: "none",
  },
  {
    id: "qwen",
    name: "Qwen",
    blurb: "Alibaba Cloud Model Studio.",
    defaultModel: "qwen-plus",
    docsUrl: "https://www.alibabacloud.com/help/en/model-studio/",
    docsLabel: "Model Studio",
    placeholder: "sk-…",
    kind: "openai",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    auth: "key",
  },
  {
    id: "zhipu",
    name: "Zhipu",
    blurb: "GLM models.",
    defaultModel: "glm-4.5",
    docsUrl: "https://open.bigmodel.cn/",
    docsLabel: "open.bigmodel.cn",
    placeholder: "…",
    kind: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    auth: "key",
  },
  {
    id: "github",
    name: "GitHub Models",
    blurb: "Models via a GitHub token.",
    defaultModel: "openai/gpt-4.1",
    docsUrl: "https://github.com/marketplace/models",
    docsLabel: "GitHub Models",
    placeholder: "ghp_… or github_pat_…",
    kind: "openai",
    baseUrl: "https://models.inference.ai.azure.com",
    auth: "key",
  },
];

export const PROVIDER_BY_ID: Record<ProviderId, ProviderDef> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p]),
) as Record<ProviderId, ProviderDef>;

export function isProviderId(value: string): value is ProviderId {
  return value in PROVIDER_BY_ID;
}

export type ProviderStatus = {
  id: ProviderId;
  name: string;
  blurb: string;
  docsUrl: string;
  docsLabel: string;
  placeholder: string;
  defaultModel: string;
  model: string;
  configured: boolean;
  hint: string | null;
  fromEnv: boolean;
  auth: ProviderAuth;
  authKind: "api_key" | "oauth" | null;
  accountId: string | null;
  featured: boolean;
};

export function keyHint(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length < 8) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

/** LobeChat/LobeHub providers we list even when not wired as live seats. */
export const LOBE_PROVIDER_CATALOG: { name: string; note: string; wired: boolean }[] = [
  { name: "OpenAI", note: "API key", wired: true },
  { name: "Codex / ChatGPT", note: "OAuth + app-server", wired: true },
  { name: "Anthropic / Claude Agent", note: "API key or setup-token", wired: true },
  { name: "Google Gemini", note: "API key (no public OAuth for third-party apps)", wired: true },
  { name: "xAI Grok", note: "API key", wired: true },
  { name: "DeepSeek", note: "API key", wired: true },
  { name: "Moonshot Kimi", note: "API key", wired: true },
  { name: "MiniMax", note: "API key", wired: true },
  { name: "OpenRouter", note: "API key", wired: true },
  { name: "Groq", note: "API key", wired: true },
  { name: "Mistral", note: "API key", wired: true },
  { name: "Together", note: "API key", wired: true },
  { name: "Fireworks", note: "API key", wired: true },
  { name: "Perplexity", note: "API key", wired: true },
  { name: "Ollama", note: "Local host, no key", wired: true },
  { name: "Qwen", note: "API key", wired: true },
  { name: "Zhipu GLM", note: "API key", wired: true },
  { name: "GitHub Models", note: "GitHub token", wired: true },
  { name: "Azure OpenAI", note: "Key + endpoint + version", wired: false },
  { name: "AWS Bedrock", note: "AWS keys + region", wired: false },
  { name: "Google Vertex AI", note: "Service account JSON", wired: false },
  { name: "Cloudflare Workers AI", note: "Account + token", wired: false },
  { name: "Hugging Face", note: "API token", wired: false },
  { name: "Cohere", note: "API key", wired: false },
  { name: "NVIDIA NIM", note: "API key", wired: false },
  { name: "Cerebras", note: "API key", wired: false },
  { name: "SambaNova", note: "API key", wired: false },
  { name: "Replicate", note: "API token", wired: false },
  { name: "DeepInfra", note: "API key", wired: false },
  { name: "Hyperbolic", note: "API key", wired: false },
  { name: "Nebius", note: "API key", wired: false },
  { name: "Friendli", note: "API key", wired: false },
  { name: "LM Studio", note: "Local host", wired: false },
  { name: "vLLM", note: "Local / compatible", wired: false },
  { name: "Xinference", note: "Local / compatible", wired: false },
  { name: "LocalAI", note: "Local host", wired: false },
  { name: "Wenxin (Baidu)", note: "API key", wired: false },
  { name: "PPIO", note: "API key", wired: false },
  { name: "SiliconFlow", note: "API key", wired: false },
  { name: "Novita", note: "API key", wired: false },
  { name: "Hunyuan", note: "API key", wired: false },
  { name: "Volcengine / Doubao", note: "API key", wired: false },
  { name: "Spark (iFlytek)", note: "API key", wired: false },
  { name: "Baichuan", note: "API key", wired: false },
  { name: "01.AI", note: "API key", wired: false },
  { name: "Stepfun", note: "API key", wired: false },
  { name: "SenseNova", note: "API key", wired: false },
  { name: "InternLM", note: "API key", wired: false },
  { name: "Gitee AI", note: "API key", wired: false },
  { name: "360 AI", note: "API key", wired: false },
  { name: "Taichu", note: "API key", wired: false },
  { name: "Upstage", note: "API key", wired: false },
  { name: "AI21", note: "API key", wired: false },
  { name: "Vercel AI Gateway", note: "API key", wired: false },
  { name: "Fal", note: "Images", wired: false },
  { name: "ComfyUI", note: "Local image runtime", wired: false },
  { name: "BFL (Flux)", note: "Images", wired: false },
  { name: "AIHubMix", note: "API key", wired: false },
  { name: "Straico", note: "API key", wired: false },
  { name: "NewAPI", note: "Compatible gateway", wired: false },
  { name: "Qiniu", note: "API key", wired: false },
  { name: "InfiniAI", note: "API key", wired: false },
  { name: "Jina", note: "API key", wired: false },
];
