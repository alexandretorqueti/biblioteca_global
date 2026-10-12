-- project_id no realtime_event_outbox é a chave de roteamento do WebSocket.
-- Tarefas de vários projetos_captados pertencem ao tenant GerenteAgentes (640).
UPDATE `realtime_event_outbox`
   SET `project_id` = 640
 WHERE `project_id` <> 640;
