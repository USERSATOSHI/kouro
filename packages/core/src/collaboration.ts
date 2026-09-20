import type { ExecutionLimits, JsonValue } from "./contracts";

export type CollaborationMessage = {
  readonly id: string;
  readonly runId: string;
  readonly senderParticipantId: string;
  readonly senderAttemptId: string;
  readonly recipientParticipantId?: string;
  readonly channel?: string;
  readonly body: JsonValue;
  readonly replyTo?: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
};

export type CollaborationSend = {
  /** Identity is deliberately absent: the host derives it from the grant. */
  readonly recipientParticipantId?: string;
  readonly channel?: string;
  readonly body: JsonValue;
  readonly replyTo?: string;
  readonly idempotencyKey: string;
  readonly expiresAt?: string;
};

export type CollaborationGrant = {
  readonly grantId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly participantId: string;
  readonly expiresAt: string;
};

export type CollaborationChannel = {
  readonly name: string;
  readonly participants: readonly string[];
  readonly maxBodyBytes?: number;
};

export type CollaborationManifest = {
  readonly batchId: string;
  readonly messageIds: readonly string[];
  readonly visible: readonly CollaborationMessage[];
  readonly omitted: ReadonlyArray<{ readonly messageId: string; readonly reason: string }>;
};

export type CollaborationLimits = Pick<
  ExecutionLimits,
  "maxMessages" | "maxTurns" | "maxInvocations" | "maxConcurrentEffects" | "maxRunDurationMs"
> & { readonly maxMessageBytes?: number };

export function collaborationBodyBytes(body: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(body)).byteLength;
}

export function assertMessageTarget(input: CollaborationSend): void {
  if ((input.recipientParticipantId ? 1 : 0) + (input.channel ? 1 : 0) !== 1)
    throw new Error("message must specify exactly one recipient or channel");
  if (!input.idempotencyKey) throw new Error("message idempotency key is required");
}
