import * as z from "zod";

import { actorSchema } from "../primitives/common.js";
import { projectIdSchema } from "../primitives/ids.js";
import { artifactPathSchema, artifactReferenceSchema } from "../primitives/values.js";
import { schemaMetadataSchema } from "./common.js";

export const repositoryReferenceSchema = z.strictObject({
  provider: z.enum(["git", "github", "gitlab", "other"]),
  defaultBranch: z.string().regex(/^[A-Za-z0-9._\/-]{1,128}$/, "Invalid branch name"),
  remoteUrl: z.string().url().optional()
});

export type RepositoryReference = z.infer<typeof repositoryReferenceSchema>;

export const projectPolicyReferenceSchema = z.strictObject({
  constitution: artifactReferenceSchema,
  currentSpecRoot: artifactPathSchema,
  changeRoot: artifactPathSchema,
  adrRoot: artifactPathSchema,
  riskPolicyRefs: z.array(artifactReferenceSchema),
  oraclePolicyRefs: z.array(artifactReferenceSchema),
  decisionOwners: z.array(actorSchema).min(1)
});

export type ProjectPolicyReference = z.infer<typeof projectPolicyReferenceSchema>;

export const projectSchema = schemaMetadataSchema.extend({
  kind: z.literal("project"),
  id: projectIdSchema,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, "Invalid project slug"),
  name: z.string().min(1).max(160),
  description: z.string().min(1).max(2_048).optional(),
  repository: repositoryReferenceSchema,
  policy: projectPolicyReferenceSchema
});

export type Project = z.infer<typeof projectSchema>;
