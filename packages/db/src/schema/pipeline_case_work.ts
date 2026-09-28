import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { pipelineCases } from "./pipeline_cases.js";
import { workspaceOperations } from "./workspace_operations.js";

/** One durable preparation issue; the host owns its assignment and turn. */
export const pipelineCaseWork = pgTable("pipeline_case_work", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  caseId: uuid("case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id),
  producerPluginId: uuid("producer_plugin_id").notNull(),
  producerPluginKey: text("producer_plugin_key").notNull(),
  turn: integer("turn").notNull().default(0),
  role: text("role").notNull().default("waiting"),
  agentId: uuid("agent_id").references(() => agents.id),
  revisionId: text("revision_id"),
  sourceRevisionId: text("source_revision_id"),
  sourceContentDigest: text("source_content_digest"),
  sourceWriteId: uuid("source_write_id").references(() => workspaceOperations.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ caseUq: uniqueIndex("pipeline_case_work_case_uq").on(t.caseId),
  issueUq: uniqueIndex("pipeline_case_work_issue_uq").on(t.issueId),
  companyIdx: index("pipeline_case_work_company_idx").on(t.companyId) }));

/** Append-only handoff receipts, also the durable wake intent for each new turn. */
export const pipelineCaseWorkTurns = pgTable("pipeline_case_work_turns", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  caseId: uuid("case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id),
  turn: integer("turn").notNull(),
  requestKey: text("request_key").notNull(),
  requestDigest: text("request_digest").notNull(),
  role: text("role").notNull(),
  agentId: uuid("agent_id").references(() => agents.id),
  revisionId: text("revision_id"),
  priorResultId: uuid("prior_result_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ turnUq: uniqueIndex("pipeline_case_work_turn_uq").on(t.caseId, t.turn),
  requestUq: uniqueIndex("pipeline_case_work_request_uq").on(t.caseId, t.requestKey) }));

/** A result keeps its original actor/run through every later reassignment. */
export const pipelineCaseWorkResults = pgTable("pipeline_case_work_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  caseId: uuid("case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
  turn: integer("turn").notNull(),
  role: text("role").notNull(),
  agentId: uuid("agent_id").notNull().references(() => agents.id),
  runId: uuid("run_id").notNull(),
  revisionId: text("revision_id").notNull(),
  contentDigest: text("content_digest").notNull(),
  result: jsonb("result").$type<Record<string, unknown>>().notNull(),
  resultDigest: text("result_digest").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ turnUq: uniqueIndex("pipeline_case_work_result_uq").on(t.caseId, t.turn) }));
