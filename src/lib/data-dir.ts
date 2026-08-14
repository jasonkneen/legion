/**
 * Where server-side state that must survive restarts lives (PGLite data, the
 * preview auth secret). The hosted sandbox runs from `/workspace`, but a local
 * clone runs from wherever it was checked out — so resolve against the process
 * cwd instead of hardcoding an absolute path. Override with `DATA_DIR` when the
 * runtime's cwd is not writable.
 */
export function dataDir(): string {
  const override = process.env.DATA_DIR;
  if (override && override.trim()) return override.trim();
  return `${process.cwd()}/.data`;
}
