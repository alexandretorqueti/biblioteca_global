ALTER TABLE `agentes` ADD `openclaw_agent_id` varchar(150);--> statement-breakpoint
ALTER TABLE `agentes` ADD CONSTRAINT `agentes_openclaw_agent_id_unique` UNIQUE(`openclaw_agent_id`);