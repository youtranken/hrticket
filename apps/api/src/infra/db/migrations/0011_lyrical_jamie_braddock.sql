CREATE TABLE "overdue_escalation_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"recipient" text NOT NULL,
	"date_vn" date NOT NULL,
	CONSTRAINT "uq_overdue_escalation" UNIQUE("recipient","date_vn")
);
--> statement-breakpoint
CREATE TABLE "reply_templates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reply_templates" ADD CONSTRAINT "reply_templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_templates" ADD CONSTRAINT "reply_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_reply_templates_project" ON "reply_templates" USING btree ("project_id");