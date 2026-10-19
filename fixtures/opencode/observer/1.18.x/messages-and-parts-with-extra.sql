-- The messages-and-parts case with fields this build does not know in every JSON blob (a newer
-- OpenCode adding keys): the same facts, no warning. Synthetic (meta.json).
INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, agent, model, time_created, time_updated, time_archived)
VALUES ('ses_archived_0003', 'prj_sample', NULL, 'sample-project', '/home/j/work/sample-project', 'Old question', '1.18.31', 10, 10, 0, 0, 0, 'build', NULL, 1790820000000, 1790820000500, 1790820000900);
INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, agent, model, time_created, time_updated)
VALUES ('ses_parts_0003', 'prj_sample', NULL, 'sample-project', '/home/j/work/sample-project', 'Read the readme', '1.18.31', 700, 50, 0, 1000, 0, 'build', '{"futureField":{"futureNested":true},"id":"sample-model","providerID":"sample-provider"}', 1790820001000, 1790820030000);

INSERT INTO message VALUES ('msg_archived_0001', 'ses_archived_0003', 1790820000100, 1790820000100,
  '{"futureField":{"futureNested":true},"role":"user","time":{"created":1790820000100}}');
INSERT INTO part VALUES ('prt_archived_0001', 'msg_archived_0001', 'ses_archived_0003', 1790820000100, 1790820000100,
  '{"futureField":{"futureNested":true},"type":"text","text":"An archived question."}');

INSERT INTO message VALUES ('msg_parts_0001', 'ses_parts_0003', 1790820002000, 1790820002000,
  '{"futureField":{"futureNested":true},"role":"user","time":{"created":1790820002000}}');
INSERT INTO part VALUES ('prt_parts_0001', 'msg_parts_0001', 'ses_parts_0003', 1790820002000, 1790820002000,
  '{"futureField":{"futureNested":true},"type":"text","text":"Read the README."}');
INSERT INTO part VALUES ('prt_parts_0002', 'msg_parts_0001', 'ses_parts_0003', 1790820002001, 1790820002001,
  '{"futureField":{"futureNested":true},"type":"text","text":"Then summarize it in one line."}');

INSERT INTO message VALUES ('msg_parts_0002', 'ses_parts_0003', 1790820003000, 1790820010000,
  '{"futureField":{"futureNested":true},"role":"assistant","parentID":"msg_parts_0001","agent":"build","time":{"created":1790820003000,"completed":1790820010000},"tokens":{"input":400,"output":20,"reasoning":0,"cache":{"read":500,"write":0}},"cost":0,"finish":"tool-calls"}');
INSERT INTO part VALUES ('prt_parts_0003', 'msg_parts_0002', 'ses_parts_0003', 1790820003100, 1790820003100,
  '{"futureField":{"futureNested":true},"type":"step-start"}');
INSERT INTO part VALUES ('prt_parts_0004', 'msg_parts_0002', 'ses_parts_0003', 1790820003200, 1790820004000,
  '{"futureField":{"futureNested":true},"type":"text","text":"Reading the README."}');
INSERT INTO part VALUES ('prt_parts_0005', 'msg_parts_0002', 'ses_parts_0003', 1790820004100, 1790820009000,
  '{"futureField":{"futureNested":true},"type":"tool","tool":"read","callID":"call_0002","state":{"status":"completed","input":{"filePath":"README.md"}}}');
INSERT INTO part VALUES ('prt_parts_0006', 'msg_parts_0002', 'ses_parts_0003', 1790820010000, 1790820010000,
  '{"futureField":{"futureNested":true},"type":"step-finish","reason":"tool-calls","tokens":{"input":400,"output":20,"reasoning":0,"cache":{"read":500,"write":0}},"cost":0}');

INSERT INTO message VALUES ('msg_parts_0003', 'ses_parts_0003', 1790820011000, 1790820020000,
  '{"futureField":{"futureNested":true},"role":"assistant","parentID":"msg_parts_0001","agent":"build","time":{"created":1790820011000,"completed":1790820020000},"tokens":{"input":300,"output":30,"reasoning":0,"cache":{"read":500,"write":0}},"cost":0,"finish":"stop"}');
INSERT INTO part VALUES ('prt_parts_0007', 'msg_parts_0003', 'ses_parts_0003', 1790820011100, 1790820019000,
  '{"futureField":{"futureNested":true},"type":"text","text":"It is a desktop panel that shows agent sessions as dwarfs."}');
INSERT INTO part VALUES ('prt_parts_0008', 'msg_parts_0003', 'ses_parts_0003', 1790820019100, 1790820019100,
  '{"futureField":{"futureNested":true},"type":"patch","hash":"abc123","files":["README.md"]}');

INSERT INTO message VALUES ('msg_parts_0004', 'ses_parts_0003', 1790820021000, 1790820030000,
  '{"futureField":{"futureNested":true},"role":"assistant","parentID":"msg_parts_0001","agent":"build","time":{"created":1790820021000},"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0}');
INSERT INTO part VALUES ('prt_parts_0009', 'msg_parts_0004', 'ses_parts_0003', 1790820021100, 1790820030000,
  '{"futureField":{"futureNested":true},"type":"text","text":"Still writ"}');
