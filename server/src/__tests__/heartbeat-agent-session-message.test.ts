import { describe, expect, it } from "vitest";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";

// An issue-scoped wake now reads the live comment count so the payload can state
// how partial its inlined comment delta is. Callers that pass an issueId must
// therefore supply a db; these context-only cases stub the single count query.
const stubCommentCountDb = (total: number) =>
  ({
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ value: total }]),
      }),
    }),
  }) as never;

describe("agent session wake messages", () => {
  it("includes the issue brief and requires fallback fetch when a long description is truncated", async () => {
    const description = [
      "Update launch-card.svg and change the CTA to Try Team free.",
      "x".repeat(13_000),
    ].join("\n");

    const wakePayload = await buildPaperclipWakePayload({
      db: stubCommentCountDb(0),
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "issue_assigned",
        issueId: "issue-1",
      },
      issueSummary: {
        id: "issue-1",
        identifier: "PAP-15271",
        title: "Preserve the task brief",
        description,
        status: "in_progress",
        priority: "high",
        workMode: "standard",
      },
    });

    expect(wakePayload?.issue).toMatchObject({
      description: expect.stringContaining("launch-card.svg"),
      descriptionTruncated: true,
    });
    expect(wakePayload?.issue?.description).toContain("Try Team free");
    expect(wakePayload?.issue?.description).toHaveLength(12_000);
    expect(wakePayload).toMatchObject({
      truncated: true,
      fallbackFetchNeeded: true,
    });
  });

  it("turns the canonical session-message context into adapter prompt input", async () => {
    const wakePayload = await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "gateway_chat_message",
        paperclipAgentMessage: {
          text: "hello",
          source: "plugin_session",
          pluginKey: "paperclip.gateway",
          sessionId: "session-1",
        },
      },
    });

    expect(wakePayload).toMatchObject({
      reason: "gateway_chat_message",
      issue: null,
      agentMessage: {
        text: "hello",
        source: "plugin_session",
        pluginKey: "paperclip.gateway",
        sessionId: "session-1",
      },
    });
    expect(renderPaperclipWakePrompt(wakePayload)).toContain("hello");
  });

  it("leaves a normal context-only wake without a renderable payload", async () => {
    await expect(
      buildPaperclipWakePayload({
        db: {} as never,
        companyId: "company-1",
        contextSnapshot: {
          wakeReason: "timer",
        },
      }),
    ).resolves.toBeNull();
  });

  it("redacts and bounds session messages before materializing the wake payload", async () => {
    const secret = "do-not-render-this-value";
    const wakePayload = await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "gateway_chat_message",
        paperclipAgentMessage: {
          text: `OPENAI_API_KEY=${secret}\n${"x".repeat(13_000)}`,
          source: "plugin_session",
          pluginKey: "paperclip.gateway",
          sessionId: "session-1",
        },
      },
    });

    expect(wakePayload?.agentMessage?.text).not.toContain(secret);
    expect(wakePayload?.agentMessage?.text.length).toBeLessThanOrEqual(12_000);
  });
});
