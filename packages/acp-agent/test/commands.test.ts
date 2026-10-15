import { expect, test } from "bun:test";
import { acpNativeCommands, parseAcpCommand } from "../src/server/commands.ts";

test("parses the commands AgentsInTheCloud runs itself and leaves every other command to the agent", () => {
  expect(parseAcpCommand("/new")).toEqual({ kind: "new" });
  expect(parseAcpCommand(" /fork ")).toEqual({ kind: "fork" });
  expect(parseAcpCommand("/resume")).toEqual({ kind: "resume", sessionId: undefined });
  expect(parseAcpCommand("/resume 01a14087-7089-7bb3-b778-6aaefbc9c6b1")).toEqual({ kind: "resume", sessionId: "01a14087-7089-7bb3-b778-6aaefbc9c6b1" });
  expect(parseAcpCommand("/model sonnet[1m]")).toEqual({ kind: "model", model: "sonnet[1m]" });
  for (const text of ["/compact", "/review this", "/newish", "hello /new"]) expect(parseAcpCommand(text)).toBeUndefined();
  for (const text of ["/new now", "/resume ../../etc", "/model", "/model two words"]) expect(() => parseAcpCommand(text)).toThrow();
});

test("offers the agent's own commands, except those AgentsInTheCloud handles, hides or Prompt templates replace", () => {
  expect(acpNativeCommands("codex", [
    { name: "compact", description: "Compact the conversation" },
    { name: "review", description: "Review changes", input: { hint: "optional instructions" } },
    { name: "model", description: "Set the model" },
    { name: "logout", description: "Sign out" },
    { name: "simplify", description: "Simplify the code" },
    { name: "$imagegen", description: "Generate images" },
  ], ["logout"], new Set(["simplify"]))).toEqual([
    { kind: "builtin", source: "codex", name: "compact", trigger: "/compact", description: "Compact the conversation", argumentHint: undefined, preserveArguments: true },
    { kind: "builtin", source: "codex", name: "review", trigger: "/review", description: "Review changes", argumentHint: "optional instructions", preserveArguments: true },
  ]);
});
