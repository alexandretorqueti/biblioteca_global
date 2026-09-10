import assert from 'node:assert/strict';
import { buildSessionPrompt, buildToolResult, parseToolCall } from '../src/SessionProtocol.js';

const prompt = buildSessionPrompt({
  context: {
    agent_id: 'agente-teste',
    workspace: '/tmp/agente-teste',
    files: [{ path: 'SOUL.md', content: 'identidade' }],
    tools: [{ name: 'exec', description: 'executa comandos', parameters: { command: 'string' } }],
  },
  firstMessage: 'Faça a tarefa inicial',
});

assert.match(prompt, /agente-teste/);
assert.match(prompt, /SOUL\.md/);
assert.match(prompt, /identidade/);
assert.match(prompt, /exec/);
assert.match(prompt, /Faça a tarefa inicial/);

const call = parseToolCall('<tool_call>{"name":"exec","arguments":{"command":"pwd"}}</tool_call>');
assert.deepEqual(call, { name: 'exec', arguments: { command: 'pwd' } });
assert.equal(parseToolCall('resposta final'), null);
assert.equal(parseToolCall('<tool_call>{"name":"exec"}</tool_call>'), null);

assert.equal(
  buildToolResult(call!, { success: true, output: '/tmp' }),
  '<tool_result>{"name":"exec","success":true,"output":"/tmp"}</tool_result>',
);

console.log('session protocol tests passed');
