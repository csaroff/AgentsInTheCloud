import * as acp from "@agentclientprotocol/sdk";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { resolveWorkspace, workspaceContainerName, workspaceRoot } from "@agents-in-the-cloud/workspace";
import type { AcpLaunch } from "./harness.ts";

export interface AcpClientHandlers {
  update(notification: acp.SessionNotification): void;
  permission(request: acp.RequestPermissionRequest): acp.RequestPermissionResponse;
  failed(error: Error): void;
}

/** Stdio stays private: no listening port or raw provider credential in a workspace. */
export async function openAcpConnection(workspaceId: string, label: string, launch: AcpLaunch, handlers: AcpClientHandlers) {
  await resolveWorkspace(workspaceId);
  const environment = Object.keys(launch.env).flatMap(name => ["--env", name]);
  const child = Bun.spawn(["docker", "exec", "-i", "--user", "agents-in-the-cloud", "--workdir", workspaceRoot, "--env", "HOME=/home/agents-in-the-cloud", ...environment, workspaceContainerName(workspaceId), ...launch.command], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...launch.env },
  });
  let stderr = "";
  const stderrDecoder = new TextDecoder();
  const stderrDrain = (async () => {
    for await (const chunk of child.stderr) stderr = (stderr + stderrDecoder.decode(chunk, { stream: true })).slice(-16000);
  })();
  const input = new WritableStream<Uint8Array>({
    async write(chunk) { child.stdin.write(chunk); await child.stdin.flush(); },
    async close() { await child.stdin.end(); },
  });
  let closing = false;
  const connection = acp.client({ name: "agents-in-the-cloud" })
    .onNotification(acp.methods.client.session.update, ({ params }) => handlers.update(params))
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => handlers.permission(params))
    .connect(acp.ndJsonStream(input, child.stdout));
  void child.exited.then(async code => {
    await stderrDrain;
    connection.close();
    if (!closing) handlers.failed(new Error(`${label} exited (${code})${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
  });
  async function close() {
    closing = true;
    connection.close();
    child.kill();
    await child.exited;
  }
  let initialized: acp.InitializeResponse;
  try {
    initialized = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "agents-in-the-cloud", title: "AgentsInTheCloud", version: "1.0.0" },
    });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    agent: connection.agent,
    /** Prompts sent while the agent works join its running turn. */
    steering: Value.Check(Type.Object({ supported: Type.Literal(true) }), initialized._meta?.steering),
    close,
  };
}
export type AcpConnection = Awaited<ReturnType<typeof openAcpConnection>>;
