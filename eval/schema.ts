import { z } from 'zod';
import type { Category } from '../src/ai/pipeline/resolve.js';

// SPEC §20.1 — schema for eval/datasets/*.jsonl synthetic test cases.

// `satisfies` keeps this enum's literals in sync with Category at compile time.
export const CategorySchema = z.enum([
  'assignment',
  'event',
  'owner_intent',
  'commitment',
  'request_to_owner',
]) satisfies z.ZodType<Category>;

const TimeHint = z.enum(['morning', 'afternoon', 'evening', 'end_of_week', 'soon', 'none']);

const ParticipantSchema = z.object({
  code: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).optional(),
  role: z.enum(['owner', 'member']),
  tz: z.string().optional(),
});

const OpenTaskSchema = z.object({
  ref: z.string(),
  title: z.string(),
  assignee: z.string().nullable(),
  due: z.string().nullable(),
});

const OpenProposalSchema = z.object({
  ref: z.string(),
  title: z.string(),
});

const MessageRefSchema = z.object({
  ref: z.string(),
  author: z.string(),
  at: z.string(),
  text: z.string(),
});

const ContextMessageSchema = MessageRefSchema;

const NewMessageSchema = MessageRefSchema.extend({
  replyTo: z.string().optional(),
  forwardFrom: z.string().optional(),
});

const ExpectedDueSchema = z.object({
  date: z.string().nullable(),
  time: z.string().nullable(),
  hint: TimeHint,
});

const ExpectedActionSchema = z.object({
  type: z.enum(['create', 'update', 'complete', 'cancel']),
  category: CategorySchema.optional(),
  assignee: z.string().nullable().optional(),
  targetRef: z.string().optional(),
  due: ExpectedDueSchema.optional(),
});

export const EvalCaseSchema = z.object({
  id: z.string(),
  tags: z.array(z.string()),
  now: z.string(),
  workspaceTz: z.string(),
  participants: z.array(ParticipantSchema),
  openTasks: z.array(OpenTaskSchema),
  openProposals: z.array(OpenProposalSchema),
  context: z.array(ContextMessageSchema),
  messages: z.array(NewMessageSchema),
  expected: z.array(ExpectedActionSchema),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;
