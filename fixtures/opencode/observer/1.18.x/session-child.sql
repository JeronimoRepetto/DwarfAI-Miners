-- A root session that delegates to a Task subagent: the child session's parent_id names the root
-- (docs/opencode-format.md Row 4). The root's directory is a Windows one, written with forward
-- slashes as OpenCode writes it (Row 3). message.data.parentID is a reply edge, never topology.
-- Synthetic (meta.json).
INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, agent, model, time_created, time_updated)
VALUES ('ses_root_0002', 'prj_sample', NULL, 'sample-project', 'C:/Users/j/Desktop/Sample-Project', 'Count the tests', '1.18.31', 900, 60, 0, 500, 100, 'build', '{"id":"sample-model","providerID":"sample-provider"}', 1790810000000, 1790810020000);
INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, agent, model, time_created, time_updated)
VALUES ('ses_child_0002', 'prj_sample', 'ses_root_0002', 'sample-project', 'C:/Users/j/Desktop/Sample-Project', 'Count test files', '1.18.31', 300, 20, 10, 0, 0, 'general', '{"id":"sample-model","providerID":"sample-provider","variant":"default"}', 1790810005000, 1790810012000);

INSERT INTO message VALUES ('msg_root_0001', 'ses_root_0002', 1790810001000, 1790810001000,
  '{"role":"user","time":{"created":1790810001000},"agent":"build"}');
INSERT INTO part VALUES ('prt_root_0001', 'msg_root_0001', 'ses_root_0002', 1790810001000, 1790810001000,
  '{"type":"text","text":"How many test files are there?"}');

INSERT INTO message VALUES ('msg_root_0002', 'ses_root_0002', 1790810002000, 1790810013000,
  '{"role":"assistant","parentID":"msg_root_0001","agent":"build","time":{"created":1790810002000,"completed":1790810013000},"tokens":{"input":500,"output":30,"reasoning":0,"cache":{"read":500,"write":100}},"cost":0,"finish":"tool-calls"}');
INSERT INTO part VALUES ('prt_root_0002', 'msg_root_0002', 'ses_root_0002', 1790810002100, 1790810002100,
  '{"type":"step-start"}');
INSERT INTO part VALUES ('prt_root_0003', 'msg_root_0002', 'ses_root_0002', 1790810002200, 1790810012900,
  '{"type":"tool","tool":"task","callID":"call_0001","state":{"status":"completed","input":{"description":"Count test files"}}}');
INSERT INTO part VALUES ('prt_root_0004', 'msg_root_0002', 'ses_root_0002', 1790810013000, 1790810013000,
  '{"type":"step-finish","reason":"tool-calls","tokens":{"input":500,"output":30,"reasoning":0,"cache":{"read":500,"write":100}},"cost":0}');

INSERT INTO message VALUES ('msg_child_0001', 'ses_child_0002', 1790810005000, 1790810005000,
  '{"role":"user","time":{"created":1790810005000},"agent":"general"}');
INSERT INTO part VALUES ('prt_child_0001', 'msg_child_0001', 'ses_child_0002', 1790810005000, 1790810005000,
  '{"type":"text","text":"Count the test files in the project."}');
INSERT INTO message VALUES ('msg_child_0002', 'ses_child_0002', 1790810006000, 1790810012000,
  '{"role":"assistant","parentID":"msg_child_0001","agent":"general","time":{"created":1790810006000,"completed":1790810012000},"tokens":{"input":300,"output":20,"reasoning":10,"cache":{"read":0,"write":0}},"cost":0,"finish":"stop"}');
INSERT INTO part VALUES ('prt_child_0002', 'msg_child_0002', 'ses_child_0002', 1790810011000, 1790810011900,
  '{"type":"text","text":"There are 42 test files."}');

INSERT INTO message VALUES ('msg_root_0003', 'ses_root_0002', 1790810014000, 1790810020000,
  '{"role":"assistant","parentID":"msg_root_0001","agent":"build","time":{"created":1790810014000,"completed":1790810020000},"tokens":{"input":400,"output":30,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0,"finish":"stop"}');
INSERT INTO part VALUES ('prt_root_0005', 'msg_root_0003', 'ses_root_0002', 1790810015000, 1790810019000,
  '{"type":"text","text":"The project has 42 test files."}');
