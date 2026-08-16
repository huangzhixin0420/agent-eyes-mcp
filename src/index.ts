import { printHelp, runDescribe } from "./cli.js";
import { runHook } from "./hook.js";
import { log } from "./log.js";
import { startMcpServer } from "./server.js";
import pkg from "../package.json";

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case undefined:
    case "serve":
      await startMcpServer();
      return;
    case "describe":
      process.exitCode = await runDescribe(rest);
      return;
    case "hook":
      await runHook();
      return;
    case "--help":
    case "-h":
    case "help":
      printHelp();
      return;
    case "--version":
    case "-v":
      process.stdout.write(`${pkg.version}\n`);
      return;
    default:
      process.stderr.write(`agent-eyes-mcp: unknown command "${cmd}".\nRun "agent-eyes-mcp --help" for usage.\n`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  log("fatal:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
