// Where the setup wizard is, and how setup reads what it reports. The wizard
// walks the steps only the Operator can take. Setup runs it in the same
// terminal, then reads what each stage left in 1Password. The App's install
// leaves nothing a user's gh can read, so for that one the wizard writes a
// line to the file FABRIK_WIZARD_REPORT names.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Env } from "./exec.ts";

/** The wizard, found from this file. #335 moves it beside the setup program: change it here. */
export const WIZARD_PATH = fileURLToPath(new URL("../../skills/fabrik-setup/wizard.sh", import.meta.url));

/** The environment variable naming the file the wizard reports to. */
export const WIZARD_REPORT_ENV = "FABRIK_WIZARD_REPORT";

export interface WizardRun {
  /** The Product repo's checkout, on the setup branch. */
  readonly cwd: string;
  /** Setup's own environment, with OP_ACCOUNT and FABRIK_WIZARD_REPORT. */
  readonly env: Env;
}

/**
 * Runs the wizard in this terminal and waits for it to end, however it ends.
 * A Ctrl-C stops only the wizard, so setup still commits, pushes and opens the
 * setup PR, and says what's left.
 */
export function runWizardInTerminal({ cwd, env }: WizardRun): Promise<void> {
  return new Promise((done) => {
    const stay = () => {};
    process.on("SIGINT", stay);
    const ended = () => {
      process.off("SIGINT", stay);
      done();
    };
    const child = spawn("bash", [WIZARD_PATH], { cwd, env, stdio: "inherit" });
    child.on("error", ended);
    child.on("close", ended);
  });
}

/** Whether the wizard's report says the Operator confirmed the Fabrik App is installed on this repo. */
export function appInstalledIn(report: string, repo: string): boolean {
  return report.split(/\r?\n/).some((line) => line.trim() === `app-installed ${repo}`);
}
