-- Add columns for per-project deploy configuration in projeto_motor_config
ALTER TABLE projeto_motor_config
ADD COLUMN deploy_script varchar(500),
ADD COLUMN deploy_host_root varchar(500);