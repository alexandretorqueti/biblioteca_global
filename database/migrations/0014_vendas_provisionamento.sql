ALTER TABLE `pedidos_venda` ADD `welcome_email_sent` boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE `pedidos_venda` MODIFY COLUMN `status` enum('pending','paid','aguardando_aceite','provisioning','provisioned','failed','refunded') NOT NULL DEFAULT 'pending';
