import { deriveOracleManifest, readOracleArtifact } from "@legion/artifacts";

import type { ShipGateOracleFact } from "./ship-gates.js";

/**
 * Reading the change-scoped planes a ship gate asks about.
 *
 * These lived inside `commands/workflow/ship.ts` while `legion ship` was the
 * only reader. `legion approve surface` is the second: it re-affirms the pins of
 * the verification surfaces this change declares, and those declarations span
 * the task contracts *and* the oracles the contracts name. A writer that walked
 * its own smaller set could re-affirm a pin the gate does not read, or miss one
 * it does — which is the writer/reader drift PR 2 closed for delta specs by
 * making the writer call the reader. Here the shared thing is which documents to
 * look at, so it is shared as a module rather than restated.
 */

/**
 * A read whose failure makes a fact absent, never a command blocked.
 *
 * The change-scoped facts feed gates whose contract is that an absent fact
 * yields `unevaluable`, so a read that fails has to arrive as absence and not as
 * a new blocking branch. The oracle manifest in particular fails on any
 * malformed oracle in the change directory, and a change with one already fails
 * earlier, for its own reason, with its own recovery command — turning it into a
 * second failure here would change which defect the operator is told about.
 *
 * This does not itself distinguish "nothing there" from "something there I could
 * not read", which the traceability checker in `@legion/artifacts` does. The
 * distinction is made one level up instead: a listing that reports `skipped`
 * entries produces a `ShipGatePlaneSkip`, which reaches the payload by name. A
 * thrown read still arrives as bare absence, which is the weaker answer and the
 * one worth improving next; what it is not is the common case, which is a file
 * the listing declined to parse.
 */
export async function absentOnFailure<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/**
 * Every oracle of the change, or `undefined` if the set could not be
 * established.
 *
 * All-or-nothing on purpose. A partial list is worse than no list for the gates
 * this feeds: "every oracle is approved" is trivially true of a list that lost
 * the unapproved one. The manifest is derived first because it is the only
 * public route to the change's oracle ids, then each is read for its document
 * and reference — the gates that consume these need `protectedPaths` and the
 * declared verification surface from the one, and the content hash from the
 * other.
 */
export async function loadOracleFacts(input: {
  readonly repositoryRoot: string;
  readonly changeId: string;
}): Promise<readonly ShipGateOracleFact[] | undefined> {
  const manifest = await absentOnFailure(() =>
    deriveOracleManifest({ repositoryRoot: input.repositoryRoot, changeId: input.changeId })
  );
  if (manifest === undefined || !manifest.ok) return undefined;

  const oracles: ShipGateOracleFact[] = [];
  for (const revision of manifest.manifest.oracles) {
    const fileName = revision.artifact.path.split("/").at(-1);
    if (fileName === undefined || !fileName.endsWith(".yaml")) return undefined;
    const oracle = await absentOnFailure(() =>
      readOracleArtifact({
        repositoryRoot: input.repositoryRoot,
        changeId: input.changeId,
        oracleId: fileName.slice(0, -".yaml".length)
      })
    );
    if (oracle === undefined || !oracle.ok) return undefined;
    oracles.push({ document: oracle.document, reference: oracle.reference });
  }

  return oracles;
}
