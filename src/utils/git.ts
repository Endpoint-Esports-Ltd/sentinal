export async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim();
  } catch {
    return null;
  }
}

export async function isInsideGitRepo(cwd: string): Promise<boolean> {
  const root = await findGitRoot(cwd);
  return root !== null;
}
