import type { BotToolTurn, ToolCall } from "../session-manager";

export interface IConsciousLoop<TConfig, TToolManifest, TTurns> {
  run(): Promise<undefined | Promise<any>>;
  abort(): void;

  getConfig(): TConfig;
  getToolManifest(): TToolManifest;
  getTurns(): TTurns;

  on<K extends keyof ConsciousLoopEvents>(
    event: K,
    listener: ConsciousLoopEvents[K]
  ): void;
}

export interface ConsciousLoopEvents {
  "run.started": () => void;
  "run.finished": () => void;

  dtmf: (digits: string) => void; // dtmf digits the bot wants to send
  "text-chunk": (text: string, last: boolean, fullText?: string) => void; // chunk of text the LLM wants to say

  "tool.starting": (turn: BotToolTurn, params: ToolCall) => void;
  "tool.finished": (turn: BotToolTurn, params: ToolCall, result: any) => void;
  "tool.error": (turn: BotToolTurn, param: ToolCall, error: any) => boolean;
}
