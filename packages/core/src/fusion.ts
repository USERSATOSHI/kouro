import type { ArtifactType } from "./contracts";
import type { AgentOptions, NodeHandle, ValueBinding, WorkflowBuilder } from "./builder";

export const MAX_FUSION_ROUNDS = 10;

/** Rounds count review/revision cycles after the initial parallel drafts. */
export function validateFusionRounds(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_FUSION_ROUNDS
  )
    throw new Error(`Fusion review rounds must be an integer from 0 to ${MAX_FUSION_ROUNDS}`);
  return value;
}

export interface FusionOptions<Plan, Review> {
  readonly task: ValueBinding;
  readonly reviewProduces: ArtifactType<Review>;
  readonly rounds: number;
  readonly reviewPrompt: string;
  readonly revisionPrompt: string;
  readonly synthesis: NodeHandle<Plan, true>;
  /** auto (default) passes reports over 16 KiB as files. */
  readonly notesTransport?: "auto" | "inline" | "files";
  /** Enabled by default; requires every reviewer to return needsRevision: false. */
  readonly stopWhenUnanimous?: boolean;
}

/** Internal declarations copied from agents supplied through the builder. */
export type FusionAgent<T> = AgentOptions<T> & { readonly id: string };
export interface FusionStagesOptions<Plan, Review> extends Omit<
  FusionOptions<Plan, Review>,
  "synthesis"
> {
  readonly members: readonly FusionAgent<Plan>[];
  readonly produces: ArtifactType<Plan>;
  readonly synthesis: FusionAgent<Plan>;
}

/** Adds finite stages with durable producer bindings; callers connect entry and result. */
export function buildFusionStages<Plan, Review>(
  workflow: WorkflowBuilder,
  id: string,
  options: FusionStagesOptions<Plan, Review>,
) {
  const rounds = validateFusionRounds(options.rounds);
  if (
    options.notesTransport !== undefined &&
    !["auto", "inline", "files"].includes(options.notesTransport)
  )
    throw new Error("Fusion notesTransport must be auto, inline or files");
  const notesTransport = options.notesTransport ?? "auto";
  if (options.stopWhenUnanimous !== undefined && typeof options.stopWhenUnanimous !== "boolean")
    throw new Error("Fusion stopWhenUnanimous must be boolean");
  const stopWhenUnanimous = options.stopWhenUnanimous ?? true;
  if (options.members.length < 2) throw new Error("Fusion requires at least two models");
  const memberIds = options.members.map((member) => member.id);
  if (
    memberIds.some((memberId) => !memberId.trim()) ||
    new Set(memberIds).size !== memberIds.length
  )
    throw new Error("Fusion members need unique nonblank IDs");
  if (memberIds.includes(options.synthesis.id))
    throw new Error("Fusion synthesis needs a distinct node ID");
  const common = (member: FusionAgent<Plan>) => {
    const { id: _id, ...agentOptions } = member;
    return { ...agentOptions, role: member.role ?? member.id, uses: member.uses ?? [] };
  };
  const stage = (groupId: string, branches: readonly NodeHandle<unknown, true>[]) => {
    const entry = workflow.parallel(groupId, { branches, maxConcurrent: branches.length });
    const join = workflow.join(`join-${groupId}`, {
      groupId,
      mode: "fail-fast",
      failure: "cancel-remaining",
    });
    entry.on("success").to(join);
    for (const branch of branches) branch.on("success").to(join);
    return { entry, join };
  };
  const drafts = options.members.map((member) =>
    workflow.agent(member.id, {
      ...common(member),
      input: { ...member.input, task: options.task },
      produces: member.produces ?? options.produces,
      fusion: {
        groupId: id,
        memberId: member.id,
        stage: "draft",
        round: 0,
        notesTransport,
        stopWhenUnanimous,
      },
    }),
  );
  const initial = stage(id, drafts);
  let previous = drafts;
  let barrier = initial.join;
  const cycles: Array<{
    reviews: NodeHandle<Review, true>[];
    revisions: NodeHandle<Plan, true>[];
  }> = [];
  for (let round = 1; round <= rounds; round++) {
    const reviews = options.members.map((member, index) =>
      workflow.agent(`${member.id}-review-${round}`, {
        ...common(member),
        prompt: `${options.reviewPrompt}\nYou are member ${index + 1}. This is review round ${round} of ${rounds}.`,
        input: {
          ...member.input,
          task: options.task,
          own: previous[index]!.output,
          ...Object.fromEntries(
            previous.flatMap((plan, peerIndex) =>
              peerIndex === index ? [] : [[`peer${peerIndex + 1}`, plan.output]],
            ),
          ),
        },
        produces: options.reviewProduces,
        fusion: {
          groupId: id,
          memberId: member.id,
          stage: "review",
          round,
          notesTransport,
          stopWhenUnanimous,
        },
      }),
    );
    const reviewStage = stage(`${id}-review-${round}`, reviews);
    barrier.on("success").to(reviewStage.entry);
    const revisions = options.members.map((member, index) =>
      workflow.agent(`${member.id}-revise-${round}`, {
        ...common(member),
        prompt: `${options.revisionPrompt}\nYou are member ${index + 1}. This is revision round ${round} of ${rounds}.`,
        input: {
          ...member.input,
          task: options.task,
          previous: previous[index]!.output,
          ...Object.fromEntries(
            reviews.map((review, reviewerIndex) => [`review${reviewerIndex + 1}`, review.output]),
          ),
        },
        produces: member.produces ?? options.produces,
        fusion: {
          groupId: id,
          memberId: member.id,
          stage: "revision",
          round,
          notesTransport,
          stopWhenUnanimous,
        },
      }),
    );
    const revisionStage = stage(`${id}-revision-${round}`, revisions);
    reviewStage.join.on("success").to(revisionStage.entry);
    cycles.push({ reviews, revisions });
    previous = revisions;
    barrier = revisionStage.join;
  }
  const result = workflow.agent(options.synthesis.id, {
    ...common(options.synthesis),
    input: {
      ...options.synthesis.input,
      task: options.task,
      ...Object.fromEntries(previous.map((plan, index) => [`member${index + 1}`, plan.output])),
      ...Object.fromEntries(
        (cycles.at(-1)?.reviews ?? []).map((review, index) => [
          `review${index + 1}`,
          review.output,
        ]),
      ),
    },
    produces: options.produces,
    fusion: {
      groupId: id,
      memberId: options.synthesis.id,
      stage: "synthesis",
      round: rounds,
      notesTransport,
      stopWhenUnanimous,
    },
  });
  barrier.on("success").to(result);
  return { entry: initial.entry, result, drafts, rounds: cycles };
}
