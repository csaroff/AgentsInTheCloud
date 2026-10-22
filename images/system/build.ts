import { mkdir } from "node:fs/promises";
import { inlineDesignSystemCss } from "../../packages/design-system/src/inline-styles.ts";
const out = new URL("./.build/", import.meta.url).pathname;
await mkdir(out, { recursive: true });
for (const entry of ["supervisor", "test-app"]) {
  const result = await Bun.build({
    entrypoints: [new URL(`./src/${entry}.ts`, import.meta.url).pathname],
    outdir: out,
    target: "bun",
    naming: "[name].js",
  });
  if (!result.success) throw new AggregateError(result.logs);
}
const client = await Bun.build({
  entrypoints: [new URL("./src/client.ts", import.meta.url).pathname],
  outdir: out,
  target: "browser",
  naming: "client.js",
  minify: true,
});
if (!client.success) throw new AggregateError(client.logs);
await Bun.write(`${out}/design-system.css`, await inlineDesignSystemCss());
// The bundled workspace helper client loads its gRPC definition at runtime from
// ../proto relative to the bundle, so it has to ship next to supervisor.js.
await Bun.write(`${out}/proto/workspace_helper.proto`, Bun.file(new URL("../../packages/workspace-helper/proto/workspace_helper.proto", import.meta.url)));
