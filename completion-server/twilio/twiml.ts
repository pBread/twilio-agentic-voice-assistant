import twilio from "twilio";
import { ConversationRelayAttributes } from "twilio/lib/twiml/VoiceResponse.js";
import { HOSTNAME } from "../../shared/env/server.js";

interface MakeConversationRelayTwiML
  extends Omit<ConversationRelayAttributes, "url"> {
  callSid: string;
  context: {};
  parameters?: object; // values are stringified json objects
}

export function makeConversationRelayTwiML({
  callSid,
  context,
  parameters = {},
  ...params
}: MakeConversationRelayTwiML): string {
  const response = new twilio.twiml.VoiceResponse();

  const connect = response.connect({
    // action endpoint will be executed when an 'end' action is dispatched to the ConversationRelay websocket
    // https://www.twilio.com/docs/voice/twiml/connect/conversationrelay#end-session-message
    // In this implementation, we use the action for transfering conversations to a human agent
    action: `https://${HOSTNAME}/call-wrapup`,
  });

  const conversationRelay = connect.conversationRelay({
    ...params,
    url: `wss://${HOSTNAME}/convo-relay/${callSid}`, // the websocket route defined below
  });

  conversationRelay.parameter({
    name: "context",
    value: JSON.stringify(context),
  });

  Object.entries(parameters).forEach(([name, value]) =>
    conversationRelay.parameter({ name, value: JSON.stringify(value) }),
  );

  return response.toString();
}
