import { pgEnum } from 'drizzle-orm/pg-core';

export const membershipRole = pgEnum('membership_role', ['owner', 'member']);
export const chatType = pgEnum('chat_type', ['group', 'supergroup']);
export const chatStatus = pgEnum('chat_status', ['pending', 'active', 'paused', 'left']);
export const messageAnalysisStatus = pgEnum('message_analysis_status', [
  'pending',
  'skipped',
  'analyzed',
  'context_only',
]);
export const batchStatus = pgEnum('batch_status', ['queued', 'running', 'done', 'failed']);
export const batchKind = pgEnum('batch_kind', ['auto', 'manual', 'reanalyze']);
export const proposalKind = pgEnum('proposal_kind', ['create', 'update', 'complete', 'cancel']);
export const proposalCategory = pgEnum('proposal_category', [
  'assignment',
  'event',
  'owner_intent',
  'commitment',
  'request_to_owner',
  'manual',
]);
export const proposalPolicyDecision = pgEnum('proposal_policy_decision', ['shown', 'suppressed']);
export const proposalStatus = pgEnum('proposal_status', [
  'pending',
  'accepted',
  'rejected',
  'superseded',
  'expired',
]);
export const proposalRejectReason = pgEnum('proposal_reject_reason', [
  'not_task',
  'duplicate',
  'already_done',
  'other',
]);
export const taskPriority = pgEnum('task_priority', ['low', 'normal', 'high']);
export const taskStatus = pgEnum('task_status', ['open', 'in_progress', 'done', 'cancelled']);
export const taskOrigin = pgEnum('task_origin', ['ai', 'manual_group', 'manual_dm', 'forward']);
export const taskEventActorType = pgEnum('task_event_actor_type', ['user', 'system', 'ai', 'apple']);
export const notificationKind = pgEnum('notification_kind', [
  'pre_due',
  'due',
  'overdue',
  'summary',
  'snooze',
]);
export const notificationStatus = pgEnum('notification_status', ['scheduled', 'sent', 'cancelled', 'failed']);
export const claimPreviousOwnerAction = pgEnum('claim_previous_owner_action', ['demote', 'remove']);
