CREATE TABLE "mail_bomb_alert_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"sender" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_mailbomb_alert" UNIQUE("project_id","sender","window_start")
);
--> statement-breakpoint
ALTER TABLE "mail_bomb_alert_log" ADD CONSTRAINT "mail_bomb_alert_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;