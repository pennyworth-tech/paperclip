import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { pipelineCases } from "./pipeline_cases.js";
import { pipelineStages } from "./pipelines.js";

/** Append-only receipts. Only the capability-checked plugin host can mint one. */
export const pipelineStageEvidence = pgTable("pipeline_stage_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  caseId: uuid("case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
  stageId: uuid("stage_id").notNull().references(() => pipelineStages.id),
  producerPluginId: uuid("producer_plugin_id").notNull(),
  producerPluginKey: text("producer_plugin_key").notNull(),
  kind: text("kind").notNull(),
  requestKey: text("request_key").notNull(),
  requestDigest: text("request_digest").notNull(),
  caseVersion: integer("case_version").notNull(),
  policyDigest: text("policy_digest").notNull(),
  revisionId: text("revision_id").notNull(),
  contentDigest: text("content_digest").notNull(),
  documentPins: jsonb("document_pins").$type<Array<{ key: string; revisionId: string }>>().notNull(),
  prerequisiteDecisionIds: jsonb("prerequisite_decision_ids").$type<string[]>().notNull(),
  readiness: text("readiness").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  caseCreatedIdx: index("pipeline_stage_evidence_case_created_idx").on(table.companyId, table.caseId, table.createdAt),
  requestUq: uniqueIndex("pipeline_stage_evidence_request_uq").on(table.companyId, table.caseId, table.producerPluginId, table.requestKey),
}));
