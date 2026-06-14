CREATE TABLE "tag_keywords" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tag_id" integer NOT NULL,
	"keyword" text NOT NULL,
	CONSTRAINT "uq_tag_keyword" UNIQUE("tag_id","keyword")
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tag_keywords" ADD CONSTRAINT "tag_keywords_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tag_keywords_tag" ON "tag_keywords" USING btree ("tag_id");--> statement-breakpoint
ALTER TABLE "category_keywords" ADD CONSTRAINT "uq_category_keyword" UNIQUE("category_id","keyword");