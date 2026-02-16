import { beforeEach, describe, expect, it } from "vitest";
import {
  CONSUMER_COMMANDS,
  findCommand,
  getAllCommands,
  PASSTHROUGH_COMMANDS,
  RELAY_COMMANDS,
  SlashCommandRegistry,
  type RegisteredCommand,
} from "./slash-command-registry.js";

describe("SlashCommandRegistry", () => {
  it("findCommand returns correct definition", () => {
    const help = findCommand("/help");
    expect(help).toBeDefined();
    expect(help!.name).toBe("/help");
    expect(help!.category).toBe("consumer");

    const cost = findCommand("/cost");
    expect(cost).toBeDefined();
    expect(cost!.category).toBe("relay");

    const compact = findCommand("/compact");
    expect(compact).toBeDefined();
    expect(compact!.category).toBe("passthrough");
  });

  it("findCommand returns undefined for unknown commands", () => {
    expect(findCommand("/nonexistent")).toBeUndefined();
  });

  it("no command name appears in multiple categories", () => {
    const allNames = getAllCommands().map((c) => c.name);
    const unique = new Set(allNames);
    expect(unique.size).toBe(allNames.length);
  });

  it("all commands have non-empty descriptions", () => {
    for (const cmd of getAllCommands()) {
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });

  it("getAllCommands includes all three lists", () => {
    const all = getAllCommands();
    expect(all.length).toBe(
      CONSUMER_COMMANDS.length + RELAY_COMMANDS.length + PASSTHROUGH_COMMANDS.length,
    );
  });
});

describe("SlashCommandRegistry (dynamic)", () => {
  let registry: SlashCommandRegistry;

  beforeEach(() => {
    registry = new SlashCommandRegistry();
  });

  it("starts with built-in commands pre-registered", () => {
    const all = registry.getAll();
    expect(all.some((c) => c.name === "/help")).toBe(true);
    expect(all.some((c) => c.name === "/clear")).toBe(true);
    expect(all.some((c) => c.name === "/model")).toBe(true);
    // All built-ins should have source "built-in"
    for (const cmd of all) {
      expect(cmd.source).toBe("built-in");
    }
  });

  it("registers commands from CLI", () => {
    registry.registerFromCLI([
      { name: "/compact", description: "Compact conversation" },
      { name: "/vim", description: "Toggle vim mode", argumentHint: "[on|off]" },
    ]);
    const vim = registry.find("/vim");
    expect(vim).toBeDefined();
    expect(vim!.source).toBe("cli");
    expect(vim!.description).toBe("Toggle vim mode");
    expect(vim!.argumentHint).toBe("[on|off]");
  });

  it("registers skills as commands", () => {
    registry.registerSkills(["commit", "review-pr", "tdd"]);
    const commit = registry.find("/commit");
    expect(commit).toBeDefined();
    expect(commit!.source).toBe("skill");
  });

  it("CLI commands override built-in descriptions", () => {
    registry.registerFromCLI([
      { name: "/model", description: "Show or switch model", argumentHint: "[model]" },
    ]);
    const model = registry.find("/model");
    expect(model!.description).toBe("Show or switch model");
    expect(model!.argumentHint).toBe("[model]");
    // Source stays built-in since it was originally built-in
    expect(model!.source).toBe("built-in");
  });

  it("clear removes non-built-in commands", () => {
    registry.registerFromCLI([{ name: "/vim", description: "Toggle vim" }]);
    registry.registerSkills(["commit"]);
    expect(registry.find("/vim")).toBeDefined();
    expect(registry.find("/commit")).toBeDefined();

    registry.clearDynamic();
    expect(registry.find("/vim")).toBeUndefined();
    expect(registry.find("/commit")).toBeUndefined();
    // Built-ins remain
    expect(registry.find("/help")).toBeDefined();
  });

  it("filters by source", () => {
    registry.registerFromCLI([{ name: "/vim", description: "Toggle vim" }]);
    registry.registerSkills(["commit"]);

    const cliCmds = registry.getBySource("cli");
    expect(cliCmds).toHaveLength(1);
    expect(cliCmds[0].name).toBe("/vim");

    const skillCmds = registry.getBySource("skill");
    expect(skillCmds).toHaveLength(1);
    expect(skillCmds[0].name).toBe("/commit");
  });

  it("find is case-insensitive on lookup", () => {
    expect(registry.find("/Help")).toBeDefined();
    expect(registry.find("/HELP")).toBeDefined();
  });
});
