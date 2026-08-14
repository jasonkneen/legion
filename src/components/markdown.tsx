import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mt-5 mb-2 text-xl font-semibold tracking-tight first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-5 mb-2 text-lg font-semibold tracking-tight first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-1.5 text-base font-semibold tracking-tight first:mt-0">{children}</h3>
  ),
  p: ({ children }) => <p className="my-2.5 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2.5 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2.5 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-border-strong pl-3 text-fg-muted">{children}</blockquote>
  ),
  a: ({ href, children }) => (
    <a href={href} className="underline decoration-border-strong underline-offset-3 hover:text-fg" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-border px-2 py-1.5 font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b border-border px-2 py-1.5">{children}</td>,
  code: ({ className, children, ...props }) => {
    const inline = !className;
    if (inline) {
      return (
        <code className="rounded-sm bg-bg-subtle px-1 py-px font-mono text-[0.86em]" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className={cn("font-mono text-[13px] leading-relaxed", className)} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-lg bg-bg-subtle px-3 py-2.5 text-[13px] leading-relaxed">
      {children}
    </pre>
  ),
};

export function RichText({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("max-w-none text-[15px] text-fg", className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
