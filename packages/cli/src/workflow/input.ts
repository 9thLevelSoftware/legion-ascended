import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  actorSchema,
  type Actor,
  type RepositoryReference,
  type UtcTimestamp
} from "@legion/protocol";

import { stringOption, type CliContext } from "../runtime.js";

export function slugFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalizeProjectSlug(slug.length > 0 ? slug : "legion-project");
}

export function ownerActor(owner: string): Actor {
  const normalized = owner
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const id = (/^[a-z][a-z0-9_.:-]{1,127}$/.test(normalized)
    ? normalized
    : `operator-${normalized || "user"}`
  ).slice(0, 128);

  return actorSchema.parse({
    kind: "human",
    id,
    ...(owner.length > 0 ? { displayName: owner } : {})
  });
}

export function createdAtOption(context: CliContext): UtcTimestamp | undefined {
  return stringOption(context, "created-at") as UtcTimestamp | undefined;
}

export function repositoryReference(repositoryRoot: string): Partial<RepositoryReference> {
  const git = (args: readonly string[]): string | undefined => {
    try {
      return execFileSync("git", ["-C", repositoryRoot, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    } catch {
      return undefined;
    }
  };

  const defaultBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const remoteUrl = git(["config", "--get", "remote.origin.url"]);
  return {
    provider: "git",
    defaultBranch: defaultBranch && defaultBranch !== "HEAD" ? defaultBranch : "main",
    ...(remoteUrl && isUrl(remoteUrl) ? { remoteUrl } : {})
  };
}

export function displayPath(context: CliContext, absolutePath: string): string {
  return path.relative(context.repositoryRoot, absolutePath).replace(/\\/g, "/") || ".";
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeProjectSlug(slug: string): string {
  const candidate = slug.length >= 3 ? slug : `legion-${slug}`;
  return candidate.slice(0, 64).replace(/-+$/g, "") || "legion-project";
}
