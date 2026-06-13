CREATE TYPE "public"."assign_strategy" AS ENUM('round_robin', 'least_load');--> statement-breakpoint
CREATE TYPE "public"."attachment_status" AS ENUM('pending', 'stored', 'blocked_unsafe', 'expired');--> statement-breakpoint
CREATE TYPE "public"."draft_kind" AS ENUM('reply', 'note');--> statement-breakpoint
CREATE TYPE "public"."inbox_status" AS ENUM('received', 'processed', 'suppressed', 'blocked', 'failed');--> statement-breakpoint
CREATE TYPE "public"."junk_rule_kind" AS ENUM('keyword', 'sender');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'processing', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."participant_status" AS ENUM('active', 'pending_approval', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."project_key" AS ENUM('hris', 'cnb');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('ssa', 'admin', 'team_lead', 'member');--> statement-breakpoint
CREATE TYPE "public"."tag_kind" AS ENUM('manual', 'auto', 'priority');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('open', 'assigned', 'in_progress', 'pending', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."view_log_action" AS ENUM('ticket_view', 'file_download');--> statement-breakpoint
CREATE TABLE "assign_cursors" (
	"category_id" integer PRIMARY KEY NOT NULL,
	"last_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "auto_assign_config" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"category_id" integer NOT NULL,
	"strategy" "assign_strategy" DEFAULT 'round_robin' NOT NULL,
	CONSTRAINT "auto_assign_config_category_id_unique" UNIQUE("category_id")
);
--> statement-breakpoint
CREATE TABLE "auto_assign_members" (
	"config_id" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "auto_assign_members_config_id_user_id_pk" PRIMARY KEY("config_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name_vi" text NOT NULL,
	"name_en" text NOT NULL,
	"is_sensitive" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category_keywords" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"category_id" integer NOT NULL,
	"keyword" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_counters" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"last_no" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" "project_key" NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "role_capabilities" (
	"role" "role" NOT NULL,
	"capability" text NOT NULL,
	"allowed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "role_capabilities_role_capability_pk" PRIMARY KEY("role","capability")
);
--> statement-breakpoint
CREATE TABLE "user_group_membership" (
	"user_id" uuid NOT NULL,
	"category_id" integer NOT NULL,
	CONSTRAINT "user_group_membership_user_id_category_id_pk" PRIMARY KEY("user_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" integer,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "role" NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"otp_enabled" boolean DEFAULT false NOT NULL,
	"language" text DEFAULT 'vi' NOT NULL,
	"away_from" date,
	"away_to" date,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_users_email" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "draft_kind" NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"recipients_json" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_draft" UNIQUE("ticket_id","user_id","kind")
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"email" text NOT NULL,
	"status" "participant_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_participant" UNIQUE("ticket_id","email")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"kind" "tag_kind" DEFAULT 'manual' NOT NULL,
	"color" text,
	CONSTRAINT "uq_tag_name" UNIQUE("project_id","name")
);
--> statement-breakpoint
CREATE TABLE "ticket_link" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticket_a" uuid NOT NULL,
	"ticket_b" uuid NOT NULL,
	"kind" text DEFAULT 'cross_post' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"from_addr" text NOT NULL,
	"to_addrs" text[],
	"cc_addrs" text[],
	"bcc_addrs" text[],
	"body_text" text,
	"body_html" text,
	"body_html_safe" text,
	"message_id" text,
	"in_reply_to" text,
	"references" text,
	"is_auto_reply" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_tags" (
	"ticket_id" uuid NOT NULL,
	"tag_id" integer NOT NULL,
	CONSTRAINT "ticket_tags_ticket_id_tag_id_pk" PRIMARY KEY("ticket_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" integer NOT NULL,
	"ticket_code" text NOT NULL,
	"subject" text NOT NULL,
	"requester_email" text NOT NULL,
	"mailbox" text NOT NULL,
	"category_id" integer,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"assignee_id" uuid,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"reopen_locked" boolean DEFAULT false NOT NULL,
	"is_junk" boolean DEFAULT false NOT NULL,
	"is_spam_thread" boolean DEFAULT false NOT NULL,
	"junked_from_category_id" integer,
	"snooze_until" date,
	"last_opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"external_source" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "uq_tickets_code_project" UNIQUE("project_id","ticket_code")
);
--> statement-breakpoint
CREATE TABLE "blocklist" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"email" text NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_blocklist" UNIQUE("project_id","email")
);
--> statement-breakpoint
CREATE TABLE "email_connections" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"imap_host" text,
	"imap_port" integer,
	"imap_user" text,
	"smtp_host" text,
	"smtp_port" integer,
	"smtp_user" text,
	"password_encrypted" text,
	"status" text DEFAULT 'unknown' NOT NULL,
	"last_checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"key" text NOT NULL,
	"subject_vi" text NOT NULL,
	"subject_en" text NOT NULL,
	"body_vi" text NOT NULL,
	"body_en" text NOT NULL,
	CONSTRAINT "uq_template" UNIQUE("project_id","key")
);
--> statement-breakpoint
CREATE TABLE "imap_cursor" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"mailbox" text NOT NULL,
	"folder" text DEFAULT 'INBOX' NOT NULL,
	"uidvalidity" text,
	"last_uid" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "imap_cursor_mailbox_unique" UNIQUE("mailbox")
);
--> statement-breakpoint
CREATE TABLE "inbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" integer NOT NULL,
	"mailbox" text NOT NULL,
	"message_id" text NOT NULL,
	"raw" text NOT NULL,
	"status" "inbox_status" DEFAULT 'received' NOT NULL,
	"ticket_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_inbox_message_mailbox" UNIQUE("message_id","mailbox")
);
--> statement-breakpoint
CREATE TABLE "junk_rules" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"kind" "junk_rule_kind" NOT NULL,
	"pattern" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_bomb_counters" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"sender" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "uq_mailbomb" UNIQUE("project_id","sender","window_start")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" integer NOT NULL,
	"to_addrs" text[] NOT NULL,
	"cc_addrs" text[],
	"bcc_addrs" text[],
	"subject" text NOT NULL,
	"body_html" text,
	"body_text" text,
	"headers" text,
	"ticket_id" uuid,
	"message_id" text,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"smtp_dispatched_at" timestamp with time zone,
	"idempotency_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"message_id" uuid,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"storage_path" text NOT NULL,
	"status" "attachment_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digest_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"recipient" text NOT NULL,
	"date_vn" date NOT NULL,
	CONSTRAINT "uq_digest" UNIQUE("recipient","date_vn")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_settings" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"allowed_extensions" text[] NOT NULL,
	"attachment_cap_mb" integer DEFAULT 50 NOT NULL,
	"autotag_attachment" boolean DEFAULT true NOT NULL,
	"autotag_crosspost" boolean DEFAULT true NOT NULL,
	"autotag_autoreply" boolean DEFAULT true NOT NULL,
	"mail_bomb_per_hour" integer DEFAULT 20 NOT NULL,
	"disk_alert_pct" integer DEFAULT 15 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminder_config" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"overdue_days" integer DEFAULT 3 NOT NULL,
	"digest_hour" integer DEFAULT 8 NOT NULL,
	"digest_enabled" boolean DEFAULT true NOT NULL,
	"digest_max_n" integer DEFAULT 20 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snooze_reminder_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"date_vn" date NOT NULL,
	CONSTRAINT "uq_snooze_reminder" UNIQUE("ticket_id","date_vn")
);
--> statement-breakpoint
CREATE TABLE "view_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"ticket_id" uuid,
	"attachment_id" uuid,
	"action" "view_log_action" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"loop_name" text PRIMARY KEY NOT NULL,
	"last_beat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assign_cursors" ADD CONSTRAINT "assign_cursors_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assign_cursors" ADD CONSTRAINT "assign_cursors_last_user_id_users_id_fk" FOREIGN KEY ("last_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_assign_config" ADD CONSTRAINT "auto_assign_config_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_assign_members" ADD CONSTRAINT "auto_assign_members_config_id_auto_assign_config_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."auto_assign_config"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_assign_members" ADD CONSTRAINT "auto_assign_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_keywords" ADD CONSTRAINT "category_keywords_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_counters" ADD CONSTRAINT "project_counters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_membership" ADD CONSTRAINT "user_group_membership_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_membership" ADD CONSTRAINT "user_group_membership_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_link" ADD CONSTRAINT "ticket_link_ticket_a_tickets_id_fk" FOREIGN KEY ("ticket_a") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_link" ADD CONSTRAINT "ticket_link_ticket_b_tickets_id_fk" FOREIGN KEY ("ticket_b") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_tags" ADD CONSTRAINT "ticket_tags_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_tags" ADD CONSTRAINT "ticket_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_junked_from_category_id_categories_id_fk" FOREIGN KEY ("junked_from_category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocklist" ADD CONSTRAINT "blocklist_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocklist" ADD CONSTRAINT "blocklist_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_connections" ADD CONSTRAINT "email_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junk_rules" ADD CONSTRAINT "junk_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_bomb_counters" ADD CONSTRAINT "mail_bomb_counters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_ticket_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ticket_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_settings" ADD CONSTRAINT "project_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_config" ADD CONSTRAINT "reminder_config_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snooze_reminder_log" ADD CONSTRAINT "snooze_reminder_log_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_log" ADD CONSTRAINT "view_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_log" ADD CONSTRAINT "view_log_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_log" ADD CONSTRAINT "view_log_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_categories_project" ON "categories" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_category_keywords_cat" ON "category_keywords" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "idx_users_project" ON "users" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_messages_ticket" ON "ticket_messages" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_messages_message_id" ON "ticket_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_project" ON "tickets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_assignee" ON "tickets" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_status" ON "tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tickets_category" ON "tickets" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "idx_inbox_status" ON "inbox_messages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_outbox_claim" ON "outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_attachments_ticket" ON "attachments" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_expires" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_actor_read" ON "notifications" USING btree ("actor_id","read_at");--> statement-breakpoint
CREATE INDEX "idx_viewlog_ticket" ON "view_log" USING btree ("ticket_id");