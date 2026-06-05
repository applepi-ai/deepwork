import { afterEach, describe, expect, it, vi } from "vitest";

type Tool = {
  name: string;
  execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }>; details: unknown }>;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../src/bridge.js");
});

describe("DeepWork extension tool handlers", () => {
  // Covers PI-REQ-002.1.1 through PI-REQ-002.13.1 by executing the registered native tool surface.
  it("registers native DeepWork tools that delegate to bridge methods with session context", async () => {
    const harness = await loadHarness();
    const ctx = { cwd: "/project", sessionManager: { getSessionId: () => "session-1" } };

    await harness.tools.deepwork_get_workflows.execute("tool-1", {}, undefined, undefined, ctx);
    expect(harness.bridge.getWorkflows).toHaveBeenCalledWith({ cwd: "/project", sessionId: "session-1", agentId: undefined });

    await harness.tools.deepwork_start_workflow.execute("tool-2", { goal: "g", job_name: "j", workflow_name: "w", session_id: "explicit", agent_id: "agent-1" }, undefined, undefined, ctx);
    expect(harness.bridge.startWorkflow).toHaveBeenCalledWith(
      { goal: "g", job_name: "j", workflow_name: "w", session_id: "explicit", agent_id: "agent-1" },
      { cwd: "/project", sessionId: "explicit", agentId: "agent-1" },
    );

    await harness.tools.deepwork_finished_step.execute("tool-3", { outputs: { result: "ok" } }, undefined, undefined, ctx);
    expect(harness.bridge.finishedStep).toHaveBeenCalledWith({ outputs: { result: "ok" } }, { cwd: "/project", sessionId: "session-1", agentId: undefined });

    await harness.tools.deepwork_abort_workflow.execute("tool-4", { explanation: "stop" }, undefined, undefined, ctx);
    expect(harness.bridge.abortWorkflow).toHaveBeenCalledWith({ explanation: "stop" }, { cwd: "/project", sessionId: "session-1", agentId: undefined });

    await harness.tools.deepwork_go_to_step.execute("tool-5", { step_id: "define" }, undefined, undefined, ctx);
    expect(harness.bridge.goToStep).toHaveBeenCalledWith({ step_id: "define" }, { cwd: "/project", sessionId: "session-1", agentId: undefined });

    await harness.tools.deepwork_get_configured_reviews.execute("tool-6", { only_rules_matching_files: ["src/a.ts"] }, undefined, undefined, ctx);
    expect(harness.bridge.getConfiguredReviews).toHaveBeenCalledWith({ only_rules_matching_files: ["src/a.ts"] }, { cwd: "/project", sessionId: "session-1", agentId: undefined });

    await harness.tools.deepwork_mark_review_as_passed.execute("tool-7", { review_id: "review-1" }, undefined, undefined, ctx);
    expect(harness.bridge.markReviewAsPassed).toHaveBeenCalledWith({ review_id: "review-1" }, { cwd: "/project", sessionId: "session-1", agentId: undefined });

    await harness.tools.deepwork_get_named_schemas.execute("tool-8", {}, undefined, undefined, ctx);
    expect(harness.bridge.getNamedSchemas).toHaveBeenCalledWith({ cwd: "/project", sessionId: "session-1", agentId: undefined });
  });

  // Covers PI-REQ-003.2.1 through PI-REQ-003.2.4 by preserving parsed review task metadata on tool details.
  it("attaches parsed review tasks to get-review-instructions tool details", async () => {
    const harness = await loadHarness({ reviewInstructions: "review text", parsedTasks: [{ description: "Prompt review" }] });

    const result = await harness.tools.deepwork_get_review_instructions.execute("tool-1", { files: ["README.md"] }, undefined, undefined, { cwd: "/project", sessionManager: { getSessionId: () => "session-1" } });

    expect(harness.bridge.getReviewInstructions).toHaveBeenCalledWith({ files: ["README.md"] }, { cwd: "/project", sessionId: "session-1", agentId: undefined });
    expect(harness.bridge.parseReviewTasks).toHaveBeenCalledWith("review text");
    expect(result.content[0].text).toBe("review text");
    expect(result.details).toEqual({ tasks: [{ description: "Prompt review" }] });
  });

  // Covers PI-REQ-003.2.5 by launching reduced-context async pi-subagents reviews when the subagent bridge is present.
  it("launches review subagents from get-review-instructions when pi-subagents acknowledges", async () => {
    const task = {
      description: "Review typescript_rule",
      reviewer: "deepwork-reviewer",
      promptFile: ".deepwork/tmp/review_instructions/review-1.md",
      reviewId: "review-1",
      ruleName: "typescript_rule",
      filesToReview: ["src/app.ts"],
    };
    const harness = await loadHarness({ reviewInstructions: "review text", parsedTasks: [task], subagentsStarted: true });

    const result = await harness.tools.deepwork_get_review_instructions.execute("tool-1", { files: ["src/app.ts"] }, undefined, undefined, { cwd: "/project", sessionManager: { getSessionId: () => "session-1" } });

    expect(result.content[0].text).toContain("DeepWork review subagents were launched asynchronously via pi-subagents.");
    expect(result.content[0].text).toContain("review_id: review-1");
    expect(result.content[0].text).toContain("deepwork_mark_review_as_passed");
    expect(result.content[0].text).not.toBe("review text");
    expect(result.details).toMatchObject({ subagents: { status: "started", reviews: [{ reviewer: "reviewer", reviewId: "review-1" }] } });

    const request = harness.emitted.find((event) => event.event === "subagent:slash:request")?.data as { params?: { tasks?: Array<{ agent?: string; task?: string; cwd?: string; output?: boolean }> } };
    expect(request?.params?.tasks?.[0]).toMatchObject({ agent: "reviewer", cwd: "/project", output: false });
    expect(request?.params?.tasks?.[0]?.task).toContain("Read .deepwork/tmp/review_instructions/review-1.md");
    expect(request?.params?.tasks?.[0]?.task).toContain("MUST call the native Pi tool `deepwork_mark_review_as_passed`");
    expect(request?.params?.tasks?.[0]?.task).toContain("DEEPWORK_REVIEW_PASSED: review-1");
  });

  // Covers PI-REQ-002.9.14 by returning generated tasks without launching subagents when autostart is disabled.
  it("does not launch review subagents from get-review-instructions when autostart is disabled", async () => {
    const task = {
      description: "Review typescript_rule",
      reviewer: "deepwork-reviewer",
      promptFile: ".deepwork/tmp/review_instructions/review-1.md",
      reviewId: "review-1",
      ruleName: "typescript_rule",
      filesToReview: ["src/app.ts"],
    };
    const harness = await loadHarness({ reviewInstructions: "review text", parsedTasks: [task], subagentsStarted: true });

    const result = await harness.tools.deepwork_get_review_instructions.execute("tool-1", { files: ["src/app.ts"], autostart_reviews_if_possible: false }, undefined, undefined, { cwd: "/project", sessionManager: { getSessionId: () => "session-1" } });

    expect(result.content[0].text).toBe("review text");
    expect(result.details).toEqual({ tasks: [task] });
    expect(harness.emitted.find((event) => event.event === "subagent:slash:request")).toBeUndefined();
  });

  // Covers PI-REQ-003.2.6 by recording pass markers reported by launched review subagents when child tools are unavailable.
  it("marks a launched review as passed from a subagent fallback pass marker", async () => {
    const task = {
      description: "Review typescript_rule",
      reviewer: "deepwork-reviewer",
      promptFile: ".deepwork/tmp/review_instructions/review-1.md",
      reviewId: "review-1",
      ruleName: "typescript_rule",
      filesToReview: ["src/app.ts"],
    };
    const harness = await loadHarness({ reviewInstructions: "review text", parsedTasks: [task], subagentsStarted: true });

    await harness.tools.deepwork_get_review_instructions.execute("tool-1", { files: ["src/app.ts"] }, undefined, undefined, { cwd: "/project", sessionManager: { getSessionId: () => "session-1" } });
    harness.emitEvent("subagent:async-complete", {
      results: [{ summary: "No actionable findings.\nDEEPWORK_REVIEW_PASSED: review-1" }],
    });
    await Promise.resolve();

    expect(harness.bridge.markReviewAsPassed).toHaveBeenCalledWith({ review_id: "review-1" }, { cwd: "/project" });
  });

  // Covers PI-REQ-003.2.7 by ignoring pass markers when DeepWork cannot identify the review project root.
  it("ignores untracked subagent pass markers without an event cwd", async () => {
    const harness = await loadHarness();

    harness.emitEvent("subagent:async-complete", {
      results: [{ summary: "DEEPWORK_REVIEW_PASSED: untracked-review" }],
    });
    await Promise.resolve();

    expect(harness.bridge.markReviewAsPassed).not.toHaveBeenCalled();
  });

  // Covers PI-REQ-003.2.8 by allowing completion events with cwd to recover pass markers after extension reloads.
  it("marks a review as passed from an event cwd even when the in-memory launch map is empty", async () => {
    const harness = await loadHarness();

    harness.emitEvent("subagent:async-complete", {
      cwd: "/project",
      results: [{ summary: "DEEPWORK_REVIEW_PASSED: review-from-event-cwd" }],
    });
    await Promise.resolve();

    expect(harness.bridge.markReviewAsPassed).toHaveBeenCalledWith({ review_id: "review-from-event-cwd" }, { cwd: "/project" });
  });

  // Covers PI-REQ-001.8.5 and PI-REQ-002.4.3 by keeping tool calls usable without session manager access.
  it("falls back to generated session IDs when session manager access fails", async () => {
    const harness = await loadHarness();

    await harness.tools.deepwork_get_workflows.execute("tool-1", {}, undefined, undefined, {
      cwd: "/project",
      sessionManager: { getSessionId: () => { throw new Error("unavailable"); } },
    });

    expect(harness.bridge.getWorkflows).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/project", sessionId: expect.stringMatching(/^pi-/) }));
  });
});

async function loadHarness(options: { reviewInstructions?: string; parsedTasks?: unknown[]; subagentsStarted?: boolean } = {}) {
  vi.resetModules();
  const bridge = {
    abortWorkflow: vi.fn(async () => ({ aborted: true })),
    finishedStep: vi.fn(async () => ({ next: true })),
    getActiveWorkflowStack: vi.fn(),
    getConfiguredReviews: vi.fn(async () => ({ reviews: [] })),
    getNamedSchemas: vi.fn(async () => ({ schemas: [] })),
    getReviewInstructions: vi.fn(async () => options.reviewInstructions ?? "instructions"),
    getWorkflows: vi.fn(async () => ({ jobs: [] })),
    goToStep: vi.fn(async () => ({ step: "define" })),
    hasApplicableReviews: vi.fn(),
    markReviewAsPassed: vi.fn(async () => ({ passed: true })),
    parseReviewTasks: vi.fn(() => options.parsedTasks ?? []),
    runDeepSchemaWriteHook: vi.fn(),
    startWorkflow: vi.fn(async () => ({ started: true })),
  };
  vi.doMock("../src/bridge.js", () => bridge);

  const { default: deepworkPi } = await import("../src/index.js");
  const tools: Record<string, Tool> = {};
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const emitted: Array<{ event: string; data: unknown }> = [];
  const events = {
    on: vi.fn((event: string, handler: (data: unknown) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event) ?? [];
        handlers.set(event, current.filter((item) => item !== handler));
      };
    }),
    emit: vi.fn((event: string, data: unknown) => {
      emitted.push({ event, data });
      if (event === "subagent:slash:request" && options.subagentsStarted) {
        const requestId = (data as { requestId?: string }).requestId;
        for (const handler of handlers.get("subagent:slash:started") ?? []) handler({ requestId });
        for (const handler of handlers.get("subagent:slash:response") ?? []) handler({ requestId, isError: false });
      }
      for (const handler of handlers.get(event) ?? []) handler(data);
    }),
  };
  const pi = {
    registerTool: vi.fn((tool: Tool) => {
      tools[tool.name] = tool;
    }),
    registerCommand: vi.fn(),
    on: vi.fn(),
    sendMessage: vi.fn(),
    events,
  };

  deepworkPi(pi as never);
  const emitEvent = (event: string, data: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(data);
  };

  return { bridge, pi, tools, emitted, emitEvent };
}
