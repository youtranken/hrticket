CREATE TABLE "allowlist" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"email" text NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_allowlist" UNIQUE("project_id","email")
);
--> statement-breakpoint
ALTER TABLE "allowlist" ADD CONSTRAINT "allowlist_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowlist" ADD CONSTRAINT "allowlist_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;