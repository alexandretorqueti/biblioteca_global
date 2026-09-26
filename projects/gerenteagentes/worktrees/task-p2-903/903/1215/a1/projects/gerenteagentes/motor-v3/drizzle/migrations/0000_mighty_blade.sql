CREATE TABLE `motor_actions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(100) NOT NULL,
	`name` varchar(255) NOT NULL,
	`primitives_json` json NOT NULL,
	`on_partial_failure` enum('continue','compensate','mark_dirty') NOT NULL DEFAULT 'continue',
	`compensation_action_id` int,
	`is_terminal` tinyint NOT NULL DEFAULT 0,
	`active` tinyint NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `motor_actions_id` PRIMARY KEY(`id`),
	CONSTRAINT `motor_actions_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `motor_catalog_proposals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source` enum('monitor','human') NOT NULL,
	`status` enum('auto_activated','pending_review','approved','rejected') NOT NULL DEFAULT 'pending_review',
	`event_id` int,
	`diagnosis` text NOT NULL,
	`proposal_json` json NOT NULL,
	`tarefa_id` varchar(100) NOT NULL,
	`subtarefa_id` int,
	`reviewed_by` varchar(100),
	`review_notes` text,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `motor_catalog_proposals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `motor_event_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`direction` enum('sent','received','event','action') NOT NULL,
	`message_type` varchar(200) NOT NULL,
	`tarefa_id` varchar(100),
	`subtarefa_id` int,
	`model` varchar(200),
	`generation` int,
	`correlation_id` varchar(200),
	`payload_json` json,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `motor_event_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `motor_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(100) NOT NULL,
	`name` varchar(255) NOT NULL,
	`category` enum('erro','verificacao','conclusao','estado','humano','infra') NOT NULL,
	`scope` enum('global','projeto','tarefa','subtarefa') NOT NULL DEFAULT 'subtarefa',
	`priority` int NOT NULL DEFAULT 100,
	`active` tinyint NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `motor_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `motor_events_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `motor_model_cooldown` (
	`id` int AUTO_INCREMENT NOT NULL,
	`model` varchar(200) NOT NULL,
	`reason` varchar(100) NOT NULL,
	`until` timestamp NOT NULL,
	`occurrences` int NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `motor_model_cooldown_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `motor_occurrences` (
	`id` int AUTO_INCREMENT NOT NULL,
	`event_id` int NOT NULL,
	`tarefa_id` varchar(100) NOT NULL,
	`subtarefa_id` int,
	`generation` int NOT NULL DEFAULT 1,
	`count` int NOT NULL DEFAULT 1,
	`last_occurred_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `motor_occurrences_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `motor_patterns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`event_id` int NOT NULL,
	`pattern` text NOT NULL,
	`match_type` enum('regex','contains','exact') NOT NULL DEFAULT 'contains',
	`match_target` enum('code','message','stack','action_result') NOT NULL DEFAULT 'message',
	`active` tinyint NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `motor_patterns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `motor_primitives` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(100) NOT NULL,
	`name` varchar(255) NOT NULL,
	`domain` enum('session','model','git','db','queue','control') NOT NULL,
	`description` text,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `motor_primitives_id` PRIMARY KEY(`id`),
	CONSTRAINT `motor_primitives_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `motor_promotion_state` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tarefa_id` varchar(100) NOT NULL,
	`dirty` tinyint NOT NULL DEFAULT 0,
	`conflict_files_json` json,
	`attempts` int NOT NULL DEFAULT 0,
	`last_attempt_at` timestamp,
	`error_message` text,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `motor_promotion_state_id` PRIMARY KEY(`id`),
	CONSTRAINT `motor_promotion_state_tarefa_id_unique` UNIQUE(`tarefa_id`)
);
--> statement-breakpoint
CREATE TABLE `motor_reactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`event_id` int NOT NULL,
	`occurrence` int NOT NULL,
	`action_id` int NOT NULL,
	`params_json` json,
	`active` tinyint NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `motor_reactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `motor_actions` ADD CONSTRAINT `motor_actions_compensation_action_id_motor_actions_id_fk` FOREIGN KEY (`compensation_action_id`) REFERENCES `motor_actions`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `motor_catalog_proposals` ADD CONSTRAINT `motor_catalog_proposals_event_id_motor_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `motor_events`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `motor_occurrences` ADD CONSTRAINT `motor_occurrences_event_id_motor_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `motor_events`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `motor_patterns` ADD CONSTRAINT `motor_patterns_event_id_motor_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `motor_events`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `motor_reactions` ADD CONSTRAINT `motor_reactions_event_id_motor_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `motor_events`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `motor_reactions` ADD CONSTRAINT `motor_reactions_action_id_motor_actions_id_fk` FOREIGN KEY (`action_id`) REFERENCES `motor_actions`(`id`) ON DELETE cascade ON UPDATE no action;