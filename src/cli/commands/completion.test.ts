import { describe, expect, test } from "bun:test";
import {
  generateBashCompletion,
  generateZshCompletion,
  generateFishCompletion,
} from "./completion.js";

describe("generateBashCompletion", () => {
  const output = generateBashCompletion();

  test("outputs a valid bash function", () => {
    expect(output).toContain("_sentinal_completions()");
    expect(output).toContain("complete -F _sentinal_completions sentinal");
    expect(output).toContain("complete -F _sentinal_completions snt");
  });

  test("includes all major subcommands", () => {
    expect(output).toContain("mcp-server");
    expect(output).toContain("memory");
    expect(output).toContain("serve");
    expect(output).toContain("install");
    expect(output).toContain("update");
    expect(output).toContain("completion");
  });

  test("includes global options", () => {
    expect(output).toContain("--version");
    expect(output).toContain("--help");
    expect(output).toContain("--skip-update-check");
  });

  test("includes subcommand options", () => {
    expect(output).toContain("--port");
    expect(output).toContain("--host");
    expect(output).toContain("--background");
  });

  test("includes completion shell args", () => {
    expect(output).toContain("bash zsh fish");
  });

  test("includes install targets", () => {
    expect(output).toContain("claude opencode both");
  });
});

describe("generateZshCompletion", () => {
  const output = generateZshCompletion();

  test("outputs a valid zsh compdef", () => {
    expect(output).toContain("#compdef sentinal snt");
    expect(output).toContain("_sentinal()");
    expect(output).toContain("_describe -t commands");
  });

  test("includes subcommand descriptions", () => {
    expect(output).toContain("serve:Start the console dashboard server");
    expect(output).toContain("memory:Memory CLI");
  });

  test("includes completion shell values", () => {
    expect(output).toContain("_values 'shell' bash zsh fish");
  });

  test("includes install target values", () => {
    expect(output).toContain("_values 'target' claude opencode both");
  });
});

describe("generateFishCompletion", () => {
  const output = generateFishCompletion();

  test("disables file completions", () => {
    expect(output).toContain("complete -c sentinal -f");
    expect(output).toContain("complete -c snt -f");
  });

  test("includes subcommands", () => {
    expect(output).toContain("-a 'serve'");
    expect(output).toContain("-a 'install'");
    expect(output).toContain("-a 'update'");
    expect(output).toContain("-a 'completion'");
  });

  test("includes subcommand options", () => {
    expect(output).toContain("-l port");
    expect(output).toContain("-l host");
    expect(output).toContain("-l background");
  });

  test("includes completion shell args", () => {
    expect(output).toContain("-a 'bash zsh fish'");
  });

  test("duplicates completions for snt alias", () => {
    // Every sentinal completion should have a matching snt one
    const sentinalLines = output.split("\n").filter((l) => l.includes("complete -c sentinal"));
    const sntLines = output.split("\n").filter((l) => l.includes("complete -c snt"));
    // snt should have at least as many completion entries (minus the -f line)
    expect(sntLines.length).toBeGreaterThanOrEqual(sentinalLines.length - 1);
  });
});
