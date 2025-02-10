import log from "../lib/logger";
import { AgentRuntime } from "./agent-runtime";
import { ContextStore } from "./context-store";
import { TurnStore } from "./turn-store";
import { ToolCall } from "./turn-store.entities";

export class SessionManager {
  agent: AgentRuntime;
  context: ContextStore;
  turns: TurnStore;

  constructor(public callSid: string) {
    this.context = new ContextStore();
    this.turns = new TurnStore(callSid);

    this.agent = new AgentRuntime(
      {
        config: {},
        instructions: "Hello world",
        resolvers: [],
        tools: [],
      },
      { context: this.context, turns: this.turns }
    );
  }
}

const session = new SessionManager("CA00000....");
session.turns.list();

session.turns.on("updatedTurn", (id) => {
  const turn = session.turns.get(id);
  log.debug("session", id, turn?.version, JSON.stringify(turn, null, 2));
});

// const turn = session.turns.addBotText({ id: "turn-0", content: "Hello" });
// turn.content = "Hello world.";
// turn.content += " Next sentence.";

const toolCall0 = {
  function: { name: "fnName", arguments: "" },
  id: "tool-id-0",
  index: 0,
  type: "function",
} as ToolCall;

const turn2 = session.turns.addBotTool({
  id: "tool-turn",
  tool_calls: [toolCall0],
});

turn2.id += "-1";

toolCall0.id += "-1";
