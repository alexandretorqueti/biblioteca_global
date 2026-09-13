-- Centraliza endpoints e destinos de infraestrutura do Motor.
INSERT IGNORE INTO `motor_configuracoes` (`chave`,`tipo`,`valor`,`valor_padrao`,`regra_validacao`,`descricao`) VALUES
('motor.realtime_events_url','string','"http://localhost:3001/internal/realtime/events"','"http://localhost:3001/internal/realtime/events"','URL valida','Endpoint interno de eventos realtime da Biblioteca Global.'),
('motor.deploy_script','string','"projects/gerenteagentes/motor-v2/scripts/deploy-host.sh"','"projects/gerenteagentes/motor-v2/scripts/deploy-host.sh"','caminho relativo ao repositorio','Script de deploy executado no host para lotes publicados.'),
('motor.deploy_host_root','string','"/home/alexandre/codigofonte/biblioteca-global"','"/home/alexandre/codigofonte/biblioteca-global"','caminho absoluto','Raiz do repositorio vista pelo host de deploy.'),
('motor.deploy_ssh_target','string','"alexandre@192.168.1.8"','"alexandre@192.168.1.8"','usuario@host','Destino SSH do host que executa o deploy.');
