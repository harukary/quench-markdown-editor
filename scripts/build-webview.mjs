import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

await build({
  entryPoints: [path.join(rootDir, "src/webview/main.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["es2020"],
  sourcemap: true,
  outfile: path.join(rootDir, "media/webview.js")
});

