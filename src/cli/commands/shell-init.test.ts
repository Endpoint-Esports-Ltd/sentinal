import { describe, expect, test } from "bun:test";
import {
  detectShell,
  getShellConfigPath,
  generateShellBlock,
  upsertBlock,
  removeBlock,
} from "./shell-init.js";
import { homedir } from "node:os";
import { join } from "node:path";

describe("detectShell", () => {
  test("detects zsh", () => {
    const original = process.env.SHELL;
    process.env.SHELL = "/bin/zsh";
    expect(detectShell()).toBe("zsh");
    process.env.SHELL = original;
  });

  test("detects bash", () => {
    const original = process.env.SHELL;
    process.env.SHELL = "/bin/bash";
    expect(detectShell()).toBe("bash");
    process.env.SHELL = original;
  });

  test("detects fish", () => {
    const original = process.env.SHELL;
    process.env.SHELL = "/usr/bin/fish";
    expect(detectShell()).toBe("fish");
    process.env.SHELL = original;
  });

  test("returns null for unknown shell", () => {
    const original = process.env.SHELL;
    process.env.SHELL = "/bin/sh";
    expect(detectShell()).toBeNull();
    process.env.SHELL = original;
  });

  test("returns null when SHELL is unset", () => {
    const original = process.env.SHELL;
    delete process.env.SHELL;
    expect(detectShell()).toBeNull();
    process.env.SHELL = original;
  });
});

describe("getShellConfigPath", () => {
  test("bash returns ~/.bashrc", () => {
    expect(getShellConfigPath("bash")).toBe(join(homedir(), ".bashrc"));
  });

  test("zsh returns ~/.zshrc", () => {
    expect(getShellConfigPath("zsh")).toBe(join(homedir(), ".zshrc"));
  });

  test("fish returns ~/.config/fish/config.fish", () => {
    expect(getShellConfigPath("fish")).toBe(
      join(homedir(), ".config", "fish", "config.fish"),
    );
  });
});

describe("generateShellBlock", () => {
  test("bash block has PATH, alias, and completion", () => {
    const block = generateShellBlock("bash");
    expect(block).toContain("# --- sentinal start ---");
    expect(block).toContain("# --- sentinal end ---");
    expect(block).toContain("export PATH=");
    expect(block).toContain('.sentinal/bin:$PATH"');
    expect(block).toContain('alias snt="sentinal"');
    expect(block).toContain("sentinal completion");
  });

  test("zsh block has PATH, alias, and completion", () => {
    const block = generateShellBlock("zsh");
    expect(block).toContain("# --- sentinal start ---");
    expect(block).toContain("# --- sentinal end ---");
    expect(block).toContain("export PATH=");
    expect(block).toContain('alias snt="sentinal"');
    expect(block).toContain("sentinal completion");
  });

  test("fish block uses fish_add_path and source", () => {
    const block = generateShellBlock("fish");
    expect(block).toContain("# --- sentinal start ---");
    expect(block).toContain("# --- sentinal end ---");
    expect(block).toContain("fish_add_path -g");
    expect(block).toContain("alias snt sentinal");
    expect(block).toContain("sentinal completion fish | source");
  });
});

describe("upsertBlock", () => {
  const block = "# --- sentinal start ---\nsome content\n# --- sentinal end ---";

  test("appends to empty file", () => {
    const result = upsertBlock("", block);
    expect(result).toContain(block);
  });

  test("appends to existing content", () => {
    const existing = "# existing config\nexport FOO=bar\n";
    const result = upsertBlock(existing, block);
    expect(result).toContain("# existing config");
    expect(result).toContain("export FOO=bar");
    expect(result).toContain(block);
  });

  test("replaces existing block", () => {
    const existing = [
      "# before",
      "# --- sentinal start ---",
      "old content",
      "# --- sentinal end ---",
      "# after",
    ].join("\n");

    const newBlock = "# --- sentinal start ---\nnew content\n# --- sentinal end ---";
    const result = upsertBlock(existing, newBlock);

    expect(result).toContain("# before");
    expect(result).toContain("new content");
    expect(result).toContain("# after");
    expect(result).not.toContain("old content");
  });

  test("handles content without trailing newline", () => {
    const existing = "no trailing newline";
    const result = upsertBlock(existing, block);
    expect(result).toContain("no trailing newline");
    expect(result).toContain(block);
  });
});

describe("removeBlock", () => {
  test("removes existing block", () => {
    const content = [
      "# before",
      "# --- sentinal start ---",
      "sentinal content",
      "# --- sentinal end ---",
      "# after",
    ].join("\n");

    const result = removeBlock(content);
    expect(result).not.toBeNull();
    expect(result).toContain("# before");
    expect(result).toContain("# after");
    expect(result).not.toContain("sentinal content");
    expect(result).not.toContain("# --- sentinal start ---");
    expect(result).not.toContain("# --- sentinal end ---");
  });

  test("returns null when no block found", () => {
    const result = removeBlock("# just some config\nexport FOO=bar\n");
    expect(result).toBeNull();
  });

  test("returns null for empty content", () => {
    const result = removeBlock("");
    expect(result).toBeNull();
  });

  test("cleans up extra blank lines after removal", () => {
    const content = [
      "# before",
      "",
      "# --- sentinal start ---",
      "sentinal content",
      "# --- sentinal end ---",
      "",
      "",
      "",
      "# after",
    ].join("\n");

    const result = removeBlock(content)!;
    expect(result).not.toBeNull();
    // Should not have more than 2 consecutive newlines
    expect(result).not.toContain("\n\n\n");
  });
});
