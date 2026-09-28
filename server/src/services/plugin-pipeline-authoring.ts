import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, pipelineCases, pipelineCaseEvents, pipelineCaseIssueLinks, pipelineCaseWork, pipelines, pipelineStages } from "@paperclipai/db";
import type { HostServices, PluginPipelineAuthoringClient } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { conflict, notFound, unprocessable } from "../errors.js";
import { pipelineService } from "./pipelines.js";
import { pipelineCaseWorkService } from "./pipeline-case-work.js";
import { lockEvidenceCase } from "./pipeline-stage-evidence.js";

type Ports = Pick<HostServices["pipelines"], keyof PluginPipelineAuthoringClient>;
const pageSchema = z.object({ limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() });
const content = { title: z.string().min(1).max(500).optional(), summary: z.string().max(100_000).optional(),
  fields: z.record(z.string(), z.unknown()).optional(), workspaceRef: z.record(z.string(), z.unknown()).optional() };
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw unprocessable("Invalid pipeline operation", { code: "validation", issues: parsed.error.issues });
  return parsed.data;
}

/** Capability and invocation-company checks are applied by the SDK host bridge. */
export function pluginPipelineAuthoring(db: Db, input: {
  pluginId: string; pluginKey: string; ensureCompany(companyId: string): Promise<void>;
}): Ports {
  const svc = pipelineService(db);
  const work = pipelineCaseWorkService(db, input);
  const scope = async (companyId: string) => { parse(z.string().uuid(), companyId); await input.ensureCompany(companyId); };
  const requirePipeline = async (companyId: string, pipelineId: string) => {
    const [row] = await db.select().from(pipelines).where(and(eq(pipelines.companyId, companyId), eq(pipelines.id, pipelineId)));
    if (!row) throw notFound("Pipeline not found");
    return row;
  };
  return {
    async publishRevision({ companyId, caseId, input: raw }) {
      await scope(companyId);
      const values = parse(z.object({ expectedVersion: z.number().int().positive(), baseRevisionId: z.string().max(200).nullable(),
        requestKey: z.string().min(1).max(200), revisionId: z.string().min(1).max(200), contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
        reason: z.string().min(1).max(2000), sourceWriteId: z.string().uuid().optional() }).strict(), raw);
      return svc.publishRevision({ ...values, companyId, caseId, producerPluginId: input.pluginId, producerPluginKey: input.pluginKey });
    },
    async list({ companyId }) {
      await scope(companyId);
      const rows = await db.select().from(pipelines).where(and(eq(pipelines.companyId, companyId), isNull(pipelines.archivedAt)))
        .orderBy(asc(pipelines.key));
      return Promise.all(rows.map(async (row) => ({ id: row.id, companyId, key: row.key, name: row.name, projectId: row.projectId,
        stages: await svc.listStages(companyId, row.id) })));
    },
    async listCases({ companyId, pipelineId, page }) {
      await scope(companyId); await requirePipeline(companyId, pipelineId);
      const paging = parse(pageSchema, page ?? {});
      return db.select({ id: pipelineCases.id, companyId: pipelineCases.companyId, pipelineId: pipelineCases.pipelineId,
        title: pipelineCases.title, caseKey: pipelineCases.caseKey, stageKey: pipelineStages.key,
        stageKind: pipelineStages.kind, version: pipelineCases.version, fields: pipelineCases.fields })
        .from(pipelineCases).innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId))
        .where(and(eq(pipelineCases.companyId, companyId), eq(pipelineCases.pipelineId, pipelineId), isNull(pipelineCases.retiredAt)))
        .orderBy(desc(pipelineCases.updatedAt), asc(pipelineCases.id)).limit(paging.limit ?? 50).offset(paging.offset ?? 0);
    },
    async createCase({ companyId, input: raw }) {
      await scope(companyId);
      const values = parse(z.object({ ...content, pipelineId: z.string().uuid(), caseKey: z.string().min(1).max(200),
        title: z.string().min(1).max(500) }).strict(), raw);
      const result = await svc.ingestCase({ ...values, companyId, actor: { type: "system" } });
      return { id: result.case.id, created: result.created };
    },
    async patchCase({ companyId, caseId, input: raw }) {
      await scope(companyId);
      const values = parse(z.object({ ...content, expectedVersion: z.number().int().positive() }).strict(), raw);
      const row = await svc.patchCaseContent({ ...values, companyId, caseId, actor: { type: "system" } });
      return { id: row.id, version: row.version };
    },
    async transitionCase({ companyId, caseId, input: raw }) {
      await scope(companyId);
      const values = parse(z.object({ expectedVersion: z.number().int().positive(), toStageKey: z.string().min(1).max(100),
        reason: z.string().max(2000).optional() }).strict(), raw);
      const result = await svc.transitionCase({ ...values, companyId, caseId, actor: { type: "system" } });
      return { id: result.case.id, version: result.case.version };
    },
    async linkIssue({ companyId, caseId, input: raw }) {
      await scope(companyId);
      const values = parse(z.object({ issueId: z.string().uuid(), role: z.enum(["origin", "conversation", "work"]) }).strict(), raw);
      return db.transaction(async (tx) => {
        await lockEvidenceCase(tx, companyId, caseId);
        const [issue] = await tx.select().from(issues).where(and(eq(issues.id, values.issueId), eq(issues.companyId, companyId)));
        if (!issue) throw notFound("Issue not found");
        const [bound] = await tx.select().from(pipelineCaseWork).where(and(eq(pipelineCaseWork.caseId, caseId), eq(pipelineCaseWork.issueId, issue.id)));
        const [prior] = await tx.select().from(pipelineCaseIssueLinks).where(and(eq(pipelineCaseIssueLinks.caseId, caseId), eq(pipelineCaseIssueLinks.issueId, issue.id)));
        if (bound && values.role !== prior?.role) throw conflict("Preparation task links are controlled by its turn", { code: "case_handoff_required" });
        if (prior && prior.role === values.role && !prior.retiredAt) return { id: prior.id };
        const [link] = await tx.insert(pipelineCaseIssueLinks).values({ companyId, caseId, issueId: issue.id, role: values.role })
          .onConflictDoUpdate({ target: [pipelineCaseIssueLinks.caseId, pipelineCaseIssueLinks.issueId],
            set: { role: values.role, retiredAt: null, updatedAt: new Date() } }).returning();
        await tx.insert(pipelineCaseEvents).values({ companyId, caseId, type: "issue_linked", actorType: "system",
          payload: { issueId: issue.id, role: values.role, pluginKey: input.pluginKey } });
        return { id: link!.id };
      });
    },
    async listEvents({ companyId, caseId, page }) {
      await scope(companyId);
      return svc.listCaseEventsPage(companyId, caseId, { ...parse(pageSchema, page ?? {}), order: "asc" });
    },
    async getWork({ companyId, caseId }) { await scope(companyId); return work.get(companyId, caseId); },
    async bindWork({ companyId, caseId, issueId }) { await scope(companyId); return work.bind(companyId, caseId, issueId); },
    async handoffWork({ companyId, caseId, input: value }) { await scope(companyId); return work.handoff(companyId, caseId, value); },
    async recordWorkResult({ companyId, caseId, input: value }) { await scope(companyId); return work.recordResult(companyId, caseId, value); },
  };
}
