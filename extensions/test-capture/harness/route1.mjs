// Single-prompt routing probe. Runs ONE harness.mjs scenario and prints a
// compact one-line JSON result. Designed to be driven by a shell loop: each
// invocation is its own short-lived process, so a crash/throw here cannot kill
// the loop (unlike a long-lived node batch runner, whose parent dies on any
// uncaught exception). Usage: node route1.mjs <bot> "<prompt>"
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const [, , bot, prompt] = process.argv;

try {
  const out = execFileSync("node", ["harness.mjs", bot, prompt, "--json"], {
    cwd: HARNESS_DIR,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 150_000,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const j = JSON.parse(out.slice(out.indexOf("{")));
  const u = j.summary || {};
  console.log(
    JSON.stringify({
      tools: u.coordinatorTools || [],
      mut: u.mutatingToolsCalled || [],
      out: u.outboundCount || 0,
    }),
  );
} catch (e) {
  console.log(JSON.stringify({ error: (e.message || String(e)).slice(0, 160) }));
}
