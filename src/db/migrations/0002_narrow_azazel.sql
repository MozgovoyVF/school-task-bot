ALTER TABLE "tasks" DROP CONSTRAINT "tasks_review_requested_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "memberships" DROP COLUMN "notify_assignments";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "review_pending";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "review_requested_by";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "review_requested_at";