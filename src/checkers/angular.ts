export interface AngularCheckResult {
  tool: "ng-build" | "ng-lint";
  severity: "error" | "warning" | "info";
  message: string;
}

const ANGULAR_FILE_PATTERNS = [
  /\.component\.ts$/,
  /\.directive\.ts$/,
  /\.pipe\.ts$/,
  /\.module\.ts$/,
  /\.guard\.ts$/,
  /\.resolver\.ts$/,
];

export function isAngularFile(filePath: string): boolean {
  return ANGULAR_FILE_PATTERNS.some((p) => p.test(filePath));
}

export function runAngularChecks(projectRoot: string): AngularCheckResult[] {
  const results: AngularCheckResult[] = [];
  const ngBuild = Bun.spawnSync(["npx", "ng", "build", "--dry-run"], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  if (ngBuild.exitCode !== 0) {
    results.push({
      tool: "ng-build",
      severity: "error",
      message: `Angular build errors: ${ngBuild.stderr.toString()}`,
    });
  }
  return results;
}
