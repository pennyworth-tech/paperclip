-- A case can link its review issue with role "review", so a review stage configured
-- with the linked_reviewer approver can resolve the reviewer from that link.
ALTER TABLE "pipeline_case_issue_links" DROP CONSTRAINT "pipeline_case_issue_links_role_check";--> statement-breakpoint
ALTER TABLE "pipeline_case_issue_links" ADD CONSTRAINT "pipeline_case_issue_links_role_check" CHECK ("pipeline_case_issue_links"."role" in ('origin', 'conversation', 'work', 'automation', 'review'));
