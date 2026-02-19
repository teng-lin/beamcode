import { beforeEach, describe, expect, it } from "vitest";
import { SlashCommandRegistry } from "./slash-command-registry.js";

describe("SlashCommandRegistry", () => {
  let registry: SlashCommandRegistry;

  beforeEach(() => {
    registry = new SlashCommandRegistry();
  });

  it("find returns correct definition with category", () => {
    const help = registry.find("/help");
    expect(help).toBeDefined();
    expect(help!.name).toBe("/help");
    expect(help!.category).toBe("consumer");

    const context = registry.find("/context");
    expect(context).toBeDefined();
    expect(context!.category).toBe("passthrough");

    const compact = registry.find("/compact");
    expect(compact).toBeDefined();
    expect(compact!.category).toBe("passthrough");
  });

  it("find returns undefined for unknown commands", () => {
    expect(registry.find("/nonexistent")).toBeUndefined();
  });

  it("no command name appears more than once", () => {
    const allNames = registry.getAll().map((c) => c.name);
    const unique = new Set(allNames);
    expect(unique.size).toBe(allNames.length);
  });

  it("all built-in commands have non-empty descriptions", () => {
    for (const cmd of registry.getAll()) {
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });

  it("getAll includes consumer and passthrough built-ins", () => {
    const all = registry.getAll();
    const categories = new Set(all.map((c) => c.category));
    expect(categories.has("consumer")).toBe(true);
    expect(categories.has("passthrough")).toBe(true);
  });

  it("starts with built-in commands pre-registered", () => {
    const all = registry.getAll();
    expect(all.some((c) => c.name === "/help")).toBe(true);
    expect(all.some((c) => c.name === "/clear")).toBe(true);
    expect(all.some((c) => c.name === "/model")).toBe(true);
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
    expect(model!.source).toBe("built-in");
  });

  it("clearDynamic removes non-built-in commands", () => {
    registry.registerFromCLI([{ name: "/vim", description: "Toggle vim" }]);
    registry.registerSkills(["commit"]);
    expect(registry.find("/vim")).toBeDefined();
    expect(registry.find("/commit")).toBeDefined();

    registry.clearDynamic();
    expect(registry.find("/vim")).toBeUndefined();
    expect(registry.find("/commit")).toBeUndefined();
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
