export interface CheckResult {
  tool: "prettier" | "eslint" | "tsc";
  severity: "error" | "warning" | "info";
  message: string;
  autoFixed?: boolean;
}

export function runTypeScriptChecks(
  filePath: string,
  projectRoot: string,
  runner: string,
): CheckResult[] {
  const results: CheckResult[] = [];

  // Prettier check + auto-fix
  const prettierCheck = Bun.spawnSync(
    [runner, "prettier", "--check", filePath],
    {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  if (prettierCheck.exitCode !== 0) {
    const prettierFix = Bun.spawnSync(
      [runner, "prettier", "--write", filePath],
      {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    if (prettierFix.exitCode === 0) {
      results.push({
        tool: "prettier",
        severity: "info",
        message: `Prettier auto-formatted ${filePath}`,
        autoFixed: true,
      });
    } else {
      results.push({
        tool: "prettier",
        severity: "error",
        message: `Prettier formatting failed: ${prettierFix.stderr.toString()}`,
      });
    }
  }

  // ESLint check + auto-fix
  const eslintResult = Bun.spawnSync([runner, "eslint", "--fix", filePath], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (eslintResult.exitCode !== 0) {
    results.push({
      tool: "eslint",
      severity: "error",
      message: `ESLint issues found: ${eslintResult.stderr.toString()}`,
    });
  }

  // TypeScript type check
  const tscResult = Bun.spawnSync([runner, "tsc", "--noEmit"], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (tscResult.exitCode !== 0) {
    results.push({
      tool: "tsc",
      severity: "error",
      message: `TypeScript type errors: ${tscResult.stdout.toString()}`,
    });
  }

  return results;
}
