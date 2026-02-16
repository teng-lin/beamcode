import { describe, expect, it } from "vitest";
import {
  CONSUMER_COMMANDS,
  findCommand,
  getAllCommands,
  PASSTHROUGH_COMMANDS,
  RELAY_COMMANDS,
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
