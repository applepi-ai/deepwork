import { afterEach, describe, expect, it, vi } from "vitest";

type Message = { message: { customType: string; content: string; display: boolean }; options: unknown };
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

const reviewOutput = [
  "description: Review src/app.ts with typescript_rule",
  "  reviewer: typescript-reviewer",
  "  prompt_file: .deepwork/tmp/review_instructions/typescript.md",
  "  review_id: typescript_rule--src-app.ts--abc123",
  "  rule_name: typescript_rule",
  "  files_to_review: src/app.ts",
  "",
  "description: Review docs/guide.md with docs_rule",
  "  reviewer: deepwork-reviewer",
  "  prompt_file: .deepwork/tmp/review_instructions/docs.md",
  "  review_id: docs_rule--docs-guide.md--def456",
  "  rule_name: docs_rule",
  "  files_to_review: docs/guide.md",
].join("\n");

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../src/bridge.js");
});

describe("/review command UX", () => {
  // Covers PI-REQ-001.4.1, PI-REQ-001.4.3, PI-REQ-002.9.6, PI-REQ-003.10.1, and PI-REQ-003.11.1.
  it("passes command file filters to native review generation and summarizes matched tasks", async () => {
    const harness = await loadHarness({ output: reviewOutput });

    await harness.commands.review.handler('--files src/app.ts,docs/guide.md "tests/a b.test.ts"', harness.ctx);

    expect(harness.bridge.getReviewInstructions).toHaveBeenCalledWith(
      { files: ["src/app.ts", "docs/guide.md", "tests/a b.test.ts"], review_cadence: "change_cycle" },
      expect.objectContaining({ cwd: "/project" }),
    );
    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0].message.customType).toBe("deepwork-review-tasks");
    expect(harness.messages[0].message.content).toContain("DeepWork review task summary:");
    expect(harness.messages[0].message.content).toContain("Review scope: src/app.ts, docs/guide.md, tests/a b.test.ts");
    expect(harness.messages[0].message.content).toContain("Matched task count: 2");
    expect(harness.messages[0].message.content).toContain("typescript-reviewer: 1");
    expect(harness.messages[0].message.content).toContain("src/app.ts");
    expect(harness.messages[0].message.content).toContain("typescript_rule--src-app.ts--abc123");
  });

  // Covers PI-REQ-001.4.5 through PI-REQ-001.4.8, PI-REQ-002.13.4, PI-REQ-003.9.5, PI-REQ-003.11.3, PI-REQ-003.11.4, and PI-REQ-003.11.5.
  it("uses improved sequential fallback wording without MCP language when subagents are unavailable", async () => {
    const harness = await loadHarness({ output: reviewOutput });

    await harness.commands.review.handler("src/app.ts", harness.ctx);

    const content = harness.messages[0].message.content;
    expect(content).toContain("Pi subagents are not available");
    expect(content).toContain("read the prompt_file with Pi file-reading tools");
    expect(content).toContain("Do not mark a review as passed when actionable findings remain");
    expect(content).toContain("apply obviously correct low-risk fixes");
    expect(content).toContain("Ask the user before applying subjective findings");
    expect(content).toContain("re-run /review for the same scope");
    expect(content).not.toMatch(/mcp__/i);
    expect(content).not.toMatch(/MCP tool/i);
  });

  // Covers PI-REQ-001.4.4, PI-REQ-001.4.6 through PI-REQ-001.4.8, PI-REQ-003.10.5, PI-REQ-003.10.6, PI-REQ-003.11.2, and PI-REQ-003.11.4.
  it("dispatches review tasks through the pi-subagents slash bridge when available", async () => {
    const harness = await loadHarness({ output: reviewOutput, subagentsStarted: true });

    await harness.commands.review.handler("", harness.ctx);

    const request = harness.emitted.find((event) => event.event === "subagent:slash:request")?.data as { params?: { tasks?: Array<{ agent?: string; task?: string; output?: boolean }> } };
    expect(request?.params?.tasks).toHaveLength(2);
    expect(request?.params?.tasks?.[0].agent).toBe("typescript-reviewer");
    expect(request?.params?.tasks?.[1].agent).toBe("reviewer");
    expect(request?.params?.tasks?.[0].output).toBe(false);
    expect(request?.params?.tasks?.[0].task).toContain("Review ID: typescript_rule--src-app.ts--abc123.");
    expect(request?.params?.tasks?.[0].task).toContain("Files to review: src/app.ts.");
    expect(request?.params?.tasks?.[0].task).toContain("Read .deepwork/tmp/review_instructions/typescript.md with Pi file-reading tools");
    expect(request?.params?.tasks?.[0].task).toContain("MUST call the native Pi tool `deepwork_mark_review_as_passed`");
    expect(request?.params?.tasks?.[0].task).not.toContain("mcp__");

    const content = harness.messages[0].message.content;
    expect(content).toContain("DeepWork review task summary:");
    expect(content).toContain("DeepWork review subagents were launched asynchronously via pi-subagents.");
    expect(content).toContain("typescript-reviewer — Review src/app.ts with typescript_rule");
    expect(content).toContain("reviewer — Review docs/guide.md with docs_rule");
    expect(content).toContain("deepwork_mark_review_as_passed");
    expect(content).toContain("apply obviously correct low-risk fixes");
    expect(content).toContain("re-run /review for the same scope");
  });

  it("falls back to sequential review tasks when async subagent launch reports an error after start", async () => {
    const harness = await loadHarness({ output: reviewOutput, subagentsFailed: "Async mode is unavailable." });

    await harness.commands.review.handler("", harness.ctx);

    const content = harness.messages[0].message.content;
    expect(content).toContain("DeepWork review task summary:");
    expect(content).toContain("Pi subagents are not available");
    expect(content).toContain("prompt_file: .deepwork/tmp/review_instructions/typescript.md");
    expect(content).not.toContain("DeepWork review subagents were launched asynchronously");
  });

  // Covers PI-REQ-001.12.4 and PI-REQ-003.11.1 for no-task review command status reporting.
  it("includes the requested scope when no review tasks are generated", async () => {
    const harness = await loadHarness({ output: "No matching DeepWork review rules." });

    await harness.commands.review.handler("src/only.ts", harness.ctx);

    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0].message.customType).toBe("deepwork-review-status");
    expect(harness.messages[0].message.content).toContain("Review scope: src/only.ts");
    expect(harness.messages[0].message.content).toContain("No matching DeepWork review rules.");
  });
});

async function loadHarness(options: { output: string; subagentsStarted?: boolean; subagentsFailed?: string }) {
  vi.resetModules();
  const bridge = {
    abortWorkflow: vi.fn(),
    finishedStep: vi.fn(),
    getActiveWorkflowStack: vi.fn(),
    getConfiguredReviews: vi.fn(),
    getNamedSchemas: vi.fn(),
    getReviewInstructions: vi.fn(async () => options.output),
    getWorkflows: vi.fn(),
    goToStep: vi.fn(),
    hasApplicableReviews: vi.fn(),
    markReviewAsPassed: vi.fn(),
    parseReviewTasks: (output: string) => {
      type ParsedTask = { description: string; reviewer: string; promptFile: string; reviewId?: string; ruleName?: string; filesToReview?: string[] };
      const tasks: ParsedTask[] = [];
      let current: Partial<ParsedTask> = {};
      const flush = () => {
        if (current.description && current.reviewer && current.promptFile) tasks.push(current as ParsedTask);
        current = {};
      };
      for (const line of output.split(/\r?\n/)) {
        if (line.startsWith("description: ")) {
          flush();
          current.description = line.slice("description: ".length).trim();
        } else if (line.trimStart().startsWith("reviewer: ")) {
          current.reviewer = line.trim().slice("reviewer: ".length).trim();
        } else if (line.trimStart().startsWith("prompt_file: ")) {
          current.promptFile = line.trim().slice("prompt_file: ".length).trim();
        } else if (line.trimStart().startsWith("review_id: ")) {
          current.reviewId = line.trim().slice("review_id: ".length).trim();
        } else if (line.trimStart().startsWith("rule_name: ")) {
          current.ruleName = line.trim().slice("rule_name: ".length).trim();
        } else if (line.trimStart().startsWith("files_to_review: ")) {
          const value = line.trim().slice("files_to_review: ".length).trim();
          current.filesToReview = value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
        }
      }
      flush();
      return tasks;
    },
    runDeepSchemaWriteHook: vi.fn(),
    startWorkflow: vi.fn(),
  };
  vi.doMock("../src/bridge.js", () => bridge);

  const { default: deepworkPi } = await import("../src/index.js");
  const commands: Record<string, { handler: CommandHandler }> = {};
  const messages: Message[] = [];
  const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
  const emitted: Array<{ event: string; data: unknown }> = [];
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, command: { handler: CommandHandler }) => {
      commands[name] = command;
    }),
    on: vi.fn(),
    sendMessage: vi.fn((message: Message["message"], sendOptions: unknown) => {
      messages.push({ message, options: sendOptions });
    }),
    events: {
      on: vi.fn((eventName: string, handler: (payload: unknown) => void) => {
        const list = eventHandlers.get(eventName) ?? [];
        list.push(handler);
        eventHandlers.set(eventName, list);
        return () => {
          const current = eventHandlers.get(eventName) ?? [];
          eventHandlers.set(eventName, current.filter((item) => item !== handler));
        };
      }),
      emit: vi.fn((eventName: string, payload: Record<string, unknown>) => {
        emitted.push({ event: eventName, data: payload });
        if (eventName === "subagent:slash:request" && (options.subagentsStarted || options.subagentsFailed)) {
          for (const handler of eventHandlers.get("subagent:slash:started") ?? []) handler({ requestId: payload.requestId });
          for (const handler of eventHandlers.get("subagent:slash:response") ?? []) handler({
            requestId: payload.requestId,
            isError: Boolean(options.subagentsFailed),
            ...(options.subagentsFailed ? { errorText: options.subagentsFailed } : {}),
          });
        }
        for (const handler of eventHandlers.get(eventName) ?? []) handler(payload);
      }),
    },
  };

  deepworkPi(pi as never);
  return {
    bridge,
    commands,
    ctx: { cwd: "/project", sessionManager: { getSessionId: () => "session-1" }, ui: { notify: vi.fn() } },
    messages,
    emitted,
  };
}
