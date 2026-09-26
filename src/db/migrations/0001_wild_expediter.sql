CREATE TYPE "public"."batch_kind" AS ENUM('auto', 'manual', 'reanalyze');--> statement-breakpoint
CREATE TYPE "public"."batch_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."chat_status" AS ENUM('pending', 'active', 'paused', 'left');--> statement-breakpoint
CREATE TYPE "public"."chat_type" AS ENUM('group', 'supergroup');--> statement-breakpoint
CREATE TYPE "public"."claim_previous_owner_action" AS ENUM('demote', 'remove');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."message_analysis_status" AS ENUM('pending', 'skipped', 'analyzed', 'context_only');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('pre_due', 'due', 'overdue', 'summary', 'snooze');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('scheduled', 'sent', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."proposal_category" AS ENUM('assignment', 'event', 'owner_intent', 'commitment', 'request_to_owner', 'manual');--> statement-breakpoint
CREATE TYPE "public"."proposal_kind" AS ENUM('create', 'update', 'complete', 'cancel');--> statement-breakpoint
CREATE TYPE "public"."proposal_policy_decision" AS ENUM('shown', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."proposal_reject_reason" AS ENUM('not_task', 'duplicate', 'already_done', 'other');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'accepted', 'rejected', 'superseded', 'expired');--> statement-breakpoint
CREATE TYPE "public"."task_event_actor_type" AS ENUM('user', 'system', 'ai', 'apple');--> statement-breakpoint
CREATE TYPE "public"."task_origin" AS ENUM('ai', 'manual_group', 'manual_dm', 'forward');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('low', 'normal', 'high');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('open', 'in_progress', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"profile" text DEFAULT 'school_ru' NOT NULL,
	"timezone" text DEFAULT 'Europe/Moscow' NOT NULL,
	"settings" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"role" "membership_role" DEFAULT 'member' NOT NULL,
	"display_name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"notify_assignments" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_workspace_user" UNIQUE("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tg_user_id" bigint NOT NULL,
	"username" text,
	"first_name" text,
	"last_name" text,
	"dm_started_at" timestamp with time zone,
	"dm_blocked" boolean DEFAULT false NOT NULL,
	"timezone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_tg_user_id_unique" UNIQUE("tg_user_id")
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tg_chat_id" bigint NOT NULL,
	"workspace_id" bigint,
	"title" text,
	"type" "chat_type" NOT NULL,
	"status" "chat_status" DEFAULT 'pending' NOT NULL,
	"analysis_enabled" boolean DEFAULT true NOT NULL,
	"reactions_enabled" boolean DEFAULT true NOT NULL,
	"added_by_user_id" bigint,
	"notice_sent_at" timestamp with time zone,
	"pending_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chats_tg_chat_id_unique" UNIQUE("tg_chat_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"tg_message_id" integer NOT NULL,
	"author_user_id" bigint,
	"sent_at" timestamp with time zone NOT NULL,
	"text" text,
	"reply_to_tg_message_id" integer,
	"reply_to_quote" text,
	"forward_origin_name" text,
	"is_forward" boolean DEFAULT false NOT NULL,
	"edited_at" timestamp with time zone,
	"analysis_status" "message_analysis_status" DEFAULT 'pending' NOT NULL,
	"batch_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_chat_tg_message" UNIQUE("chat_id","tg_message_id")
);
--> statement-breakpoint
CREATE TABLE "analysis_batches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chat_id" bigint,
	"status" "batch_status" DEFAULT 'queued' NOT NULL,
	"kind" "batch_kind" DEFAULT 'auto' NOT NULL,
	"first_message_id" bigint,
	"last_message_id" bigint,
	"message_count" integer DEFAULT 0 NOT NULL,
	"prompt_version" text,
	"prefilter_model" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(10, 6),
	"latency_ms" integer,
	"raw_response" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"chat_id" bigint,
	"batch_id" bigint,
	"kind" "proposal_kind" NOT NULL,
	"category" "proposal_category",
	"payload" jsonb NOT NULL,
	"target_task_id" bigint,
	"confidence" real NOT NULL,
	"policy_decision" "proposal_policy_decision" NOT NULL,
	"policy_reason" text,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"reject_reason" "proposal_reject_reason",
	"source_message_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"owner_dm_message_id" integer,
	"notified_at" timestamp with time zone,
	"decided_by_user_id" bigint,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_id" bigint NOT NULL,
	"actor_type" "task_event_actor_type" NOT NULL,
	"actor_user_id" bigint,
	"type" text NOT NULL,
	"diff" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"assignee_user_id" bigint,
	"assignee_name_text" text,
	"assignee_all" boolean DEFAULT false NOT NULL,
	"due_at" timestamp with time zone,
	"due_all_day" boolean DEFAULT false NOT NULL,
	"due_tz" text,
	"priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"review_pending" boolean DEFAULT false NOT NULL,
	"review_requested_by" bigint,
	"review_requested_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by_user_id" bigint,
	"cancelled_at" timestamp with time zone,
	"origin" "task_origin" NOT NULL,
	"proposal_id" bigint,
	"source_chat_id" bigint,
	"source_tg_message_id" integer,
	"source_link" text,
	"source_quote" text,
	"created_by_user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"task_id" bigint,
	"recipient_user_id" bigint NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"status" "notification_status" DEFAULT 'scheduled' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_tg_message_id" integer,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "app_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_codes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" bigint NOT NULL,
	"code_hash" text NOT NULL,
	"created_by_user_id" bigint NOT NULL,
	"previous_owner_action" "claim_previous_owner_action" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_reports" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"last_notified_at" timestamp with time zone,
	"sample" jsonb
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_batch_id_analysis_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."analysis_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_batches" ADD CONSTRAINT "analysis_batches_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_batches" ADD CONSTRAINT "analysis_batches_first_message_id_messages_id_fk" FOREIGN KEY ("first_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_batches" ADD CONSTRAINT "analysis_batches_last_message_id_messages_id_fk" FOREIGN KEY ("last_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_batch_id_analysis_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."analysis_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_target_task_id_tasks_id_fk" FOREIGN KEY ("target_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_review_requested_by_users_id_fk" FOREIGN KEY ("review_requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_chat_id_chats_id_fk" FOREIGN KEY ("source_chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_codes" ADD CONSTRAINT "claim_codes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_codes" ADD CONSTRAINT "claim_codes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_codes" ADD CONSTRAINT "claim_codes_used_by_user_id_users_id_fk" FOREIGN KEY ("used_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_one_owner" ON "memberships" USING btree ("workspace_id") WHERE "memberships"."role" = 'owner';--> statement-breakpoint
CREATE INDEX "messages_chat_status_sent_at" ON "messages" USING btree ("chat_id","analysis_status","sent_at");--> statement-breakpoint
CREATE INDEX "analysis_batches_chat_status" ON "analysis_batches" USING btree ("chat_id","status");--> statement-breakpoint
CREATE INDEX "proposals_payload_title_trgm" ON "proposals" USING gin (("payload"->>'title') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tasks_workspace_status_due" ON "tasks" USING btree ("workspace_id","status","due_at");--> statement-breakpoint
CREATE INDEX "tasks_workspace_assignee_status" ON "tasks" USING btree ("workspace_id","assignee_user_id","status");--> statement-breakpoint
CREATE INDEX "tasks_title_trgm" ON "tasks" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tasks_description_trgm" ON "tasks" USING gin ("description" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "notifications_status_fire_at" ON "notifications" USING btree ("status","fire_at");