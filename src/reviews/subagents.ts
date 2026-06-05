import { randomUUID } from "node:crypto";

export type ReviewTaskForSubagent = {
  description: string;
  reviewer: string;
  promptFile: string;
  reviewId?: string;
  ruleName?: string;
  filesToReview?: string[];
};

export type PiEventBus = {
  on(event: string, handler: (data: unknown) => void): (() => void) | void;
  emit(event: string, data: unknown): void;
};

export type ReviewSubagentLaunch = {
  requestId: string;
  status: "started" | "unavailable" | "failed";
  reviews: LaunchedReviewSubagent[];
  error?: string;
};

export type LaunchedReviewSubagent = {
  reviewer: string;
  description: string;
  reviewId?: string;
  ruleName?: string;
  filesToReview?: string[];
  promptFile: string;
};

const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";

export async function launchReviewSubagentsIfAvailable(input: {
  events: PiEventBus;
  tasks: ReviewTaskForSubagent[];
  cwd: string;
  timeoutMs?: number;
}): Promise<ReviewSubagentLaunch> {
  if (input.tasks.length === 0) {
    return { requestId: "", status: "unavailable", reviews: [] };
  }

  const requestId = `deepwork-review-${randomUUID()}`;
  const reviews = input.tasks.map(toLaunchedReview);
  const timeoutMs = input.timeoutMs ?? 2_000;
  const unavailableTimeoutMs = Math.min(timeoutMs, 150);

  return new Promise((resolve) => {
    const unsubscribers: Array<() => void> = [];
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      for (const unsubscribe of unsubscribers) unsubscribe();
    };

    const finish = (result: ReviewSubagentLaunch) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const subscribe = (event: string, handler: (data: unknown) => void) => {
      const unsubscribe = input.events.on(event, handler);
      if (typeof unsubscribe === "function") unsubscribers.push(unsubscribe);
    };

    let timeout = setTimeout(() => {
      finish({
        requestId,
        status: "unavailable",
        reviews: [],
        error: "pi-subagents slash bridge did not acknowledge the launch request.",
      });
    }, unavailableTimeoutMs);

    subscribe(SLASH_SUBAGENT_STARTED_EVENT, (data) => {
      if (!matchesRequest(data, requestId)) return;
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        finish({ requestId, status: "started", reviews });
      }, timeoutMs);
    });

    subscribe(SLASH_SUBAGENT_RESPONSE_EVENT, (data) => {
      if (!matchesRequest(data, requestId)) return;
      const response = data as { isError?: unknown; errorText?: unknown };
      if (response.isError === true) {
        finish({
          requestId,
          status: "failed",
          reviews: [],
          error: typeof response.errorText === "string" ? response.errorText : "pi-subagents failed to launch review agents.",
        });
        return;
      }
      finish({ requestId, status: "started", reviews });
    });

    input.events.emit(SLASH_SUBAGENT_REQUEST_EVENT, {
      requestId,
      params: {
        tasks: input.tasks.map((task) => ({
          agent: task.reviewer === "deepwork-reviewer" ? "reviewer" : task.reviewer,
          task: subagentReviewPrompt(task),
          cwd: input.cwd,
          output: false,
        })),
        concurrency: Math.max(1, Math.min(input.tasks.length, 4)),
        context: "fresh",
        async: true,
        clarify: false,
        cwd: input.cwd,
      },
    });
  });
}

export function formatLaunchedReviewSubagentsForAgent(launch: ReviewSubagentLaunch): string {
  const lines = [
    "DeepWork review subagents were launched asynchronously via pi-subagents.",
    `Subagent request_id: ${launch.requestId}`,
    "The review prompts contain the full instructions; this response is intentionally reduced to avoid duplicating review context.",
    "Completion notifications/results will arrive through pi-subagents. If you need status, inspect the pi-subagents async run for this request.",
    "",
    "Running review agents:",
  ];

  launch.reviews.forEach((review, index) => {
    lines.push(`${index + 1}. ${review.reviewer} — ${review.description}`);
    if (review.reviewId) lines.push(`   review_id: ${review.reviewId}`);
    if (review.ruleName) lines.push(`   rule_name: ${review.ruleName}`);
    if (review.filesToReview && review.filesToReview.length > 0) lines.push(`   files: ${review.filesToReview.join(", ")}`);
    lines.push(`   prompt_file: ${review.promptFile}`);
  });

  lines.push("");
  lines.push("Each review agent was instructed to call `deepwork_mark_review_as_passed` with its review_id if and only if the review passes with no actionable findings.");
  return lines.join("\n");
}

export function subagentReviewPrompt(task: ReviewTaskForSubagent): string {
  return [
    `You are running a DeepWork review task: ${task.description}.`,
    task.reviewId ? `Review ID: ${task.reviewId}.` : "",
    task.filesToReview && task.filesToReview.length > 0 ? `Files to review: ${task.filesToReview.join(", ")}.` : "",
    `Read ${task.promptFile} with Pi file-reading tools and follow its instructions exactly. The prompt file is the authoritative review context; do not ask the parent for the full prompt unless the file cannot be read.`,
    "Report findings with file and line references. If there are no findings, say so clearly.",
    "If this review passes with no actionable findings, you MUST call the native Pi tool `deepwork_mark_review_as_passed` with this review_id before finishing. Do not mark the review as passed while actionable findings remain.",
    task.reviewId ? `If that tool is unavailable in your subagent environment, include the exact line \`DEEPWORK_REVIEW_PASSED: ${task.reviewId}\` in your final response if and only if the review passed with no actionable findings. The parent DeepWork extension will use that explicit pass marker to record the pass.` : "",
    "Do not edit project/source files unless the review instructions explicitly permit it. Returning findings through your normal response is allowed.",
  ].filter(Boolean).join("\n\n");
}

function toLaunchedReview(task: ReviewTaskForSubagent): LaunchedReviewSubagent {
  return {
    reviewer: task.reviewer === "deepwork-reviewer" ? "reviewer" : task.reviewer,
    description: task.description,
    promptFile: task.promptFile,
    ...(task.reviewId ? { reviewId: task.reviewId } : {}),
    ...(task.ruleName ? { ruleName: task.ruleName } : {}),
    ...(task.filesToReview ? { filesToReview: task.filesToReview } : {}),
  };
}

function matchesRequest(data: unknown, requestId: string): boolean {
  return typeof data === "object" && data !== null && (data as { requestId?: unknown }).requestId === requestId;
}
