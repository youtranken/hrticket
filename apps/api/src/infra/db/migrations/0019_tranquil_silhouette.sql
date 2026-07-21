CREATE TABLE "category_sender_rules" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"pattern" text NOT NULL,
	"category_id" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_category_sender_rule" UNIQUE("project_id","pattern")
);
--> statement-breakpoint
ALTER TABLE "category_sender_rules" ADD CONSTRAINT "category_sender_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_sender_rules" ADD CONSTRAINT "category_sender_rules_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_sender_rules" ADD CONSTRAINT "category_sender_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_category_sender_rule_project" ON "category_sender_rules" USING btree ("project_id");