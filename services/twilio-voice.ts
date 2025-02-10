import twilio from "twilio";
import type { RecordingListInstanceCreateOptions } from "twilio/lib/rest/api/v2010/account/call/recording";
import {
  TWILIO_ACCOUNT_SID as accountSid,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
} from "../lib/env";

const client = twilio(TWILIO_API_KEY, TWILIO_API_SECRET, { accountSid });

/**
 * @function startRecording
 * Starts recording the call
 * @param {RecordingListInstanceCreateOptions} [options] - Options for recording creation.
 * @see https://www.twilio.com/docs/voice/api/recording#create-a-recording-resource
 */
export async function startRecording(
  callSid: string,
  options: RecordingListInstanceCreateOptions = {}
) {
  const call = await client
    .calls(callSid)
    .recordings.create({ recordingChannels: "dual", ...options });

  if (call.errorCode) return { status: "error", call };

  const mediaUrl = `https://api.twilio.com${call.uri.replace(".json", "")}`;
  return { status: "success", call, mediaUrl };
}

export interface TwilioCallWebhookPayload {
  CallSid: string;
  AccountSid: string;
  From: string;
  To: string;
  ApiVersion: string;
  Direction: "inbound" | "outbound-api";
  CallStatus:
    | "queued"
    | "ringing"
    | "in-progress"
    | "completed"
    | "busy"
    | "failed"
    | "no-answer";

  CallCost?: string;
  CallerId?: string;
  CallerName?: string;
  Duration?: string;
  ForwardedFrom?: string;
  FromCity?: string;
  FromCountry?: string;
  FromState?: string;
  FromZip?: string;
  RecordingSid?: string;
  RecordingUrl?: string;
  StartTime?: string;
  ToCity?: string;
  ToCountry?: string;
  ToState?: string;
  ToZip?: string;
}
