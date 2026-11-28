ALTER TABLE `pedidos` ADD `token_acompanhamento` varchar(64);
--> statement-breakpoint
ALTER TABLE `pedidos` ADD CONSTRAINT `pedidos_token_acompanhamento_unico` UNIQUE(`token_acompanhamento`);
