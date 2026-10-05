-- One root session (parent_id NULL): one person turn and one dwarf reply in two steps.
-- Synthetic (meta.json), in the shapes of docs/opencode-format.md Rows 3 and 14.
INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, agent, model, time_created, time_updated)
VALUES ('ses_parent_0001', 'prj_sample', NULL, 'sample-project', '/home/j/work/sample-project', 'What does this project do', '1.18.31', 1200, 80, 40, 3000, 0, 'build', '{"id":"sample-model","providerID":"sample-provider"}', 1790800000000, 1790800009000);

INSERT INTO message VALUES ('msg_parent_0001', 'ses_parent_0001', 1790800001000, 1790800001000,
  '{"role":"user","time":{"created":1790800001000},"agent":"build","model":{"providerID":"sample-provider","modelID":"sample-model"}}');
INSERT INTO part VALUES ('prt_parent_0001', 'msg_parent_0001', 'ses_parent_0001', 1790800001000, 1790800001000,
  '{"type":"text","text":"What does this project do?"}');

INSERT INTO message VALUES ('msg_parent_0002', 'ses_parent_0001', 1790800002000, 1790800009000,
  '{"role":"assistant","parentID":"msg_parent_0001","mode":"build","agent":"build","path":{"cwd":"/home/j/work/sample-project","root":"/home/j/work/sample-project"},"modelID":"sample-model","providerID":"sample-provider","time":{"created":1790800002000,"completed":1790800009000},"tokens":{"total":4320,"input":1200,"output":80,"reasoning":40,"cache":{"read":3000,"write":0}},"cost":0,"finish":"stop"}');
INSERT INTO part VALUES ('prt_parent_0002', 'msg_parent_0002', 'ses_parent_0001', 1790800002100, 1790800002100,
  '{"type":"step-start","snapshot":"snap01"}');
INSERT INTO part VALUES ('prt_parent_0003', 'msg_parent_0002', 'ses_parent_0001', 1790800002200, 1790800004000,
  '{"type":"reasoning","text":"The person wants a summary.","time":{"start":1790800002200,"end":1790800004000}}');
INSERT INTO part VALUES ('prt_parent_0004', 'msg_parent_0002', 'ses_parent_0001', 1790800004100, 1790800008800,
  '{"type":"text","text":"It renders a board of dwarfs, one per agent session.","time":{"start":1790800004100,"end":1790800008800}}');
INSERT INTO part VALUES ('prt_parent_0005', 'msg_parent_0002', 'ses_parent_0001', 1790800008900, 1790800008900,
  '{"type":"step-finish","reason":"stop","snapshot":"snap02","tokens":{"input":1200,"output":80,"reasoning":40,"cache":{"read":3000,"write":0}},"cost":0}');
