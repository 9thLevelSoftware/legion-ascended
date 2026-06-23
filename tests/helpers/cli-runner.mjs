export async function runCliCapture(args, options = {}) {
  const { runCli } = await import("../../packages/cli/dist/index.js");
  let stdout = "";
  let stderr = "";
  const cwd = options.cwd ?? process.cwd();
  const exitCode = await runCli(args, {
    cwd,
    stdout: {
      write(chunk) {
        stdout += String(chunk);
        return true;
      }
    },
    stderr: {
      write(chunk) {
        stderr += String(chunk);
        return true;
      }
    }
  });
  return { exitCode, stdout, stderr };
}

export function parseJsonOutput(result) {
  const text = result.stdout.trim();
  if (text.length === 0) {
    throw new Error("CLI stdout was empty");
  }
  return JSON.parse(text);
}
