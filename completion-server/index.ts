import { RequestHandler, Router } from "express";
import { WebsocketRequestHandler } from "express-ws";
import * as agents from "../agents/index.js";
import { getMakeLogger } from "../lib/logger.js";
import { DEFAULT_TWILIO_NUMBER, HOSTNAME } from "../shared/env/server.js";
import { CallDetails } from "../shared/session/context.js";
import { AgentResolver } from "./agent-resolver/index.js";
import { AgentResolverConfig } from "./agent-resolver/types.js";
import { OpenAIConsciousLoop } from "./conscious-loop/openai.js";
import { SessionStore } from "./session-store/index.js";
import { setupSyncSession, updateCallStatus } from "./session-store/sync.js";
import {
  ConversationRelayAdapter,
  HandoffData,
} from "./twilio/conversation-relay-adapter.js";
import { makeConversationRelayTwiML } from "./twilio/twiml.js";
import {
  endCall,
  placeCall,
  type TwilioCallWebhookPayload,
} from "./twilio/voice.js";

const router = Router();

/****************************************************
 Phone Number Webhooks
****************************************************/
router.post("/incoming-call", async (req, res) => {
  const body = req.body as TwilioCallWebhookPayload;

  const dt = new Date();
  const call: CallDetails = {
    callSid: body.CallSid,
    direction: "inbound",
    from: body.From,
    to: body.To,
    participantPhone: body.From,
    startedAt: dt.toISOString(),
    localStartDate: dt.toLocaleDateString(),
    localStartTime: dt.toLocaleTimeString(),
    status: body.CallStatus,
  };

  const log = getMakeLogger(call.callSid);

  try {
    const agent = agents["owl_tickets"]; // todo: make this fetchable
    await setupSyncSession(call.callSid); // ensure the sync session is setup before connecting to Conversation Relay

    const welcomeGreeting = "Hello there. I am a voice bot";
    const twiml = makeConversationRelayTwiML({
      callSid: call.callSid,
      context: { call },
      welcomeGreeting,
      parameters: { agent, welcomeGreeting },
    });
    res.status(200).type("text/xml").end(twiml);
  } catch (error) {
    log.error("/incoming-call", "unknown error", error);
    res.status(500).json({ status: "error", error });
  }
});

router.post("/call-status", async (req, res) => {
  const callSid = req.body.CallSid as TwilioCallWebhookPayload["CallSid"];
  const callStatus = req.body
    .CallStatus as TwilioCallWebhookPayload["CallStatus"];

  const log = getMakeLogger(callSid);

  log.info(
    "/call-status",
    `call status updated to ${callStatus}, CallSid ${callSid}`,
  );

  try {
    await updateCallStatus(callSid, callStatus);
  } catch (error) {
    log.warn(
      "/call-status",
      `unable to update call status in Sync, CallSid ${callSid}`,
    );
  }

  res.status(200).send();
});

/****************************************************
 Outbound Calling Routes
****************************************************/
const outboundCallHandler: RequestHandler = async (req, res) => {
  const to = req.query?.to ?? req.body?.to;
  const from = req.query?.from ?? req.body?.from ?? DEFAULT_TWILIO_NUMBER;

  const log = getMakeLogger();

  if (!to) {
    res.status(400).send({ status: "failed", error: "No to number defined" });
    return;
  }

  if (!from) {
    res.status(400).send({ status: "failed", error: "No from number defined" });
    return;
  }

  try {
    const call = await placeCall({
      from,
      to,
      url: `https://${HOSTNAME}/outbound/answer`, // The URL is executed when the callee answers and that endpoint (below) returns TwiML. It's possible to simply include TwiML in the call creation request but the websocket route includes the callSid as a param. This could be simplified a bit, but this is fine.
    });

    res.status(200).json(call);
  } catch (error) {
    log.error(`/outbound, Error: `, error);
    res.status(500).json({ status: "failed", error });
  }
};

router.get("/outbound", outboundCallHandler);
router.post("/outbound", outboundCallHandler);

router.post("/outbound/answer", async (req, res) => {
  const body = req.body as TwilioCallWebhookPayload;

  const dt = new Date();
  const call: CallDetails = {
    callSid: body.CallSid,
    direction: "outbound",
    from: body.From,
    to: body.To,
    participantPhone: body.From,
    startedAt: dt.toISOString(),
    localStartDate: dt.toLocaleDateString(),
    localStartTime: dt.toLocaleTimeString(),
    status: body.CallStatus,
  };

  const log = getMakeLogger(call.callSid);

  log.info(`/outbound/answer`, `CallSid ${call.callSid}`);

  try {
    const agent = agents["owl_tickets"]; // todo: make this fetchable
    await setupSyncSession(call.callSid); // ensure the sync session is setup before connecting to Conversation Relay

    const twiml = makeConversationRelayTwiML({
      callSid: call.callSid,
      context: { agent, call },
    });
    res.status(200).type("text/xml").end(twiml);
  } catch (error) {
    log.error("/incoming-call", "unknown error", error);
    res.status(500).json({ status: "failed", error });
  }
});

/****************************************************
 Conversation Relay Websocket
****************************************************/
export const CONVERSATION_RELAY_WS_ROUTE = "/convo-relay/:callSid";
export const conversationRelayWebsocketHandler: WebsocketRequestHandler = (
  ws,
  req,
) => {
  const { callSid } = req.params;

  const log = getMakeLogger(callSid);
  log.info("/convo-relay", `websocket initializing, CallSid ${callSid}`);

  const relay = new ConversationRelayAdapter(ws);
  const store = new SessionStore(callSid);

  const agent = new AgentResolver(relay, store, {
    llmConfig: { model: "gpt-3.5-turbo" },
  });

  const consciousLoop = new OpenAIConsciousLoop(store, agent, relay);

  relay.onSetup((ev) => {
    // handle setup
    const params = ev.customParameters ?? {};
    const context = "context" in params ? JSON.parse(params.context) : {};
    store.setContext({
      ...context,
      call: { ...context.call, conversationRelaySessionId: ev.sessionId },
    });

    const config = JSON.parse(params.agent) as Partial<AgentResolverConfig>;
    agent.configure(config);

    const greeting = JSON.parse(params.welcomeGreeting);
    if (greeting) {
      store.turns.addBotText({ content: greeting });
      log.info("llm.transcript", `"${greeting}"`);
    }
  });

  relay.onPrompt((ev) => {
    if (!ev.last) return; // do nothing on partial speech
    log.info(`relay.prompt`, `"${ev.voicePrompt}"`);

    store.turns.addHumanText({ content: ev.voicePrompt });
    consciousLoop.run();
  });

  relay.onInterrupt((ev) => {
    log.info(`relay.interrupt`, `human interrupted bot`);

    consciousLoop.abort();
    store.turns.redactInterruption(ev.utteranceUntilInterrupt);
  });

  relay.onDTMF((ev) => {
    log.info(`relay.dtmf`, `dtmf (human): ${ev.digit}`);
  });

  // relay.onError only emits errors received from the ConversationRelay websocket, not local errors.
  relay.onError((ev) => {
    log.error(`relay.error`, `ConversationRelay error: ${ev.description}`);
  });

  consciousLoop.on("text-chunk", (text, last, fullText) => {
    relay.sendTextToken(text, last); // send each token as it is received

    if (last && fullText) log.info("llm.transcript", `"${fullText}"`);
  });

  consciousLoop.on("dtmf", (digits) => {
    relay.sendDTMF(digits);
    log.info("llm", `dtmf (bot): ${digits}`);
  });

  ws.on("close", () => {
    log.info(
      "relay",
      "conversation relay ws closed.",
      "\n/** session turns **/\n",
      JSON.stringify(store.turns.list(), null, 2),
      "\n/** session context **/\n",
      JSON.stringify(store.context, null, 2),
    );
  });
};

/****************************************************
 Executed After Conversation Relay Session Ends
 https://www.twilio.com/docs/voice/twiml/connect/conversationrelay#end-session-message
 Used for transfering calls to a human agent.
****************************************************/
router.post("/call-wrapup", async (req, res) => {
  const isHandoff = "HandoffData" in req.body;
  const callSid = req.body.CallSid;

  const log = getMakeLogger(callSid);

  if (!isHandoff) {
    log.info(`/call-wrapup`, "call completed w/out handoff data");
    res.status(200).send("complete");
    return;
  }

  let handoffData: HandoffData;
  try {
    handoffData = JSON.parse(req.body.HandoffData) as HandoffData;
  } catch (error) {
    log.error(
      `/call-wrapup`,
      "Unable to parse handoffData in wrapup webhook. ",
      "Request Body: ",
      JSON.stringify(req.body),
    );
    res.status(500).send({ status: "failed", error });
    return;
  }

  if (handoffData.reason === "error") {
    log.info(
      "/call-wrapup",
      `wrapping up call that failed due to error, callSid: ${callSid}, message: ${handoffData.message}`,
    );

    await endCall(callSid);

    res.status(200).send("complete");
    return;
  }

  if (isHandoff) {
    log.info(
      "/call-wrapup",
      `Live agent handoff starting. CallSid: ${callSid}`,
    );
  }
});

export const completionServerRoutes = router;
