import PQueue from "p-queue";
import twilio from "twilio";
import { SyncClient, type SyncMap } from "twilio-sync";
import log, { getMakeLogger } from "../../lib/logger.js";
import {
  TWILIO_ACCOUNT_SID as accountSid,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_SYNC_SVC_SID,
} from "../../shared/env.js";
import type {
  CallDetails,
  SessionContext,
  SessionMetaData,
} from "../../shared/session/context.js";
import type { TurnRecord } from "../../shared/session/turns.js";
import {
  CALL_STREAM,
  makeContextMapName,
  makeTurnMapName,
} from "../../shared/sync/ids.js";

/****************************************************
 Sync Queue Service
****************************************************/
// todo: add service-level queue to ensure one call doesn't affect others
// todo: add global queue to ensure the webhook executions don't affect the other services

export class SyncQueueService {
  private queueCounts: Map<string, number> = new Map(); // Prevents updates from stacking. Updates occur much more quickly than the update requests resolve. We skip all update queue items except for the last one to ensure only no redundant updates fire.
  private queues: Map<string, PQueue> = new Map();

  public ctxMapPromise: Promise<SyncMap>;
  public turnMapPromise: Promise<SyncMap>;

  private log: ReturnType<typeof getMakeLogger>;

  constructor(
    private callSid: string,
    private sync: SyncClient,
    private getContext: () => Partial<SessionContext>,
    private getTurn: (turnId: string) => TurnRecord | undefined,
  ) {
    this.log = getMakeLogger(callSid);

    this.ctxMapPromise = this.sync.map(makeContextMapName(this.callSid));
    this.turnMapPromise = this.sync.map(makeTurnMapName(this.callSid));

    this.initialize();
  }

  private initialize = async () => {
    await this.ctxMapPromise;
    await this.turnMapPromise;
    await this.sendNewCallStreamMsg();
  };

  sendNewCallStreamMsg = async () => {
    const client = twilio(TWILIO_API_KEY, TWILIO_API_SECRET, { accountSid });

    const syncSvcApi = client.sync.v1.services(TWILIO_SYNC_SVC_SID);
    const map = await syncSvcApi
      .syncMaps(makeContextMapName(this.callSid))
      .fetch();

    await syncSvcApi.syncStreams
      .create({ uniqueName: CALL_STREAM })
      .catch((error) => {
        if (
          typeof error === "object" &&
          "code" in error &&
          error.code === 54301
        ) {
          return; // ignore unique name already exists errors because this is always called https://www.twilio.com/docs/api/errors/54301
        }

        log.error("sync.queue", "error creating stream", error);
      });

    // note: this must match the SessionMetaData in the UI's store
    const session: SessionMetaData = {
      id: this.callSid,
      callSid: this.callSid,
      dateCreated: map.dateCreated.toISOString(),
    };

    await syncSvcApi
      .syncStreams(CALL_STREAM)
      .streamMessages.create({ data: session });
  };

  updateContext = async <K extends keyof SessionContext>(
    key: K,
  ): Promise<void> => {
    const queueKey = `${this.callSid}:context:${key}`;
    const queue = this.getQueue(queueKey);

    try {
      await queue.add(async () => {
        const count = this.queueCounts.get(queueKey) || 0;
        if (count > 1) return this.queueCounts.set(queueKey, count - 1);

        const value = this.getContext()[key]; // get latest version of the context value
        this.queueCounts.delete(queueKey);

        if (typeof value !== "object") {
          this.log.warn(
            "sync.queue",
            `context item ${key} is not an object and could not be sent to sync. value: `,
            value,
          );
        }

        const ctxMap = await this.ctxMapPromise;
        if (value === null || value === undefined)
          await ctxMap.remove(key); // removed undefined properties
        else await ctxMap.set(key, value as unknown as Record<string, unknown>);
      });
    } catch (error) {
      if (isSyncMapItemNotFound(error)) {
        this.log.warn(
          "sync.queue",
          `Failed to remove the SyncMapItem holding context property ${key}.`,
        );
        return;
      }
      this.log.error(
        "sync.queue",
        `Failed to queue context update for ${queueKey}:`,
        error,
      );
    }

    this.cleanupQueue(queue, queueKey);
  };

  updateTurn = async (turnId: string): Promise<void> => {
    const queueKey = `${this.callSid}:turn:${turnId}`;
    const queue = this.getQueue(queueKey);

    try {
      await queue.add(async () => {
        const count = this.queueCounts.get(queueKey) || 0;
        if (count > 1) return this.queueCounts.set(queueKey, count - 1);

        const turn = this.getTurn(turnId); // get latest version of the turn
        this.queueCounts.delete(queueKey);
        if (!turn) return; // the turn may have been deleted by the time this update was triggered

        const turnMap = await this.turnMapPromise;
        await turnMap.set(turnId, turn as unknown as Record<string, unknown>);
      });
    } catch (error) {
      this.log.error(
        "sync.queue",
        `Failed to queue turn update for ${queueKey}:`,
        error,
      );
    }

    this.cleanupQueue(queue, queueKey);
  };

  addTurn = async (turn: TurnRecord): Promise<void> => {
    const queueKey = `${this.callSid}:turn:${turn.id}`;
    const queue = this.getQueue(queueKey);

    try {
      await queue.add(
        async () => {
          const turnMap = await this.turnMapPromise;
          await turnMap.set(
            turn.id,
            turn as unknown as Record<string, unknown>,
          );
        },
        { priority: 1 }, // Higher priority for new turns
      );
    } catch (error) {
      this.log.error(
        "sync.queue",
        `Failed to queue turn addition for ${queueKey}:`,
        error,
      );
    }

    this.cleanupQueue(queue, queueKey);
  };

  deleteTurn = async (turnId: string): Promise<void> => {
    const queueKey = `${this.callSid}:turn:${turnId}`;
    const queue = this.getQueue(queueKey);

    try {
      await queue.add(async () => {
        const turnMap = await this.turnMapPromise;
        await turnMap.remove(turnId);
      });
    } catch (error) {
      if (isSyncMapItemNotFound(error)) {
        this.log.warn(
          "sync.queue",
          `Attempted to delete turn but it did not exist. It may have already been deleted. turnId: ${turnId}`,
        );
      } else
        this.log.error(
          "sync.queue",
          `Failed to queue turn deletion for ${queueKey}`,
        );
    }

    this.cleanupQueue(queue, queueKey);
  };

  private getQueue = (queueKey: string): PQueue => {
    let queue = this.queues.get(queueKey);
    if (!queue) {
      queue = new PQueue({
        concurrency: 1,
        intervalCap: 100,
        interval: 1000,
        carryoverConcurrencyCount: true,
        timeout: 10 * 1000,
      });

      queue.on("error", (error) => {
        if (isSyncMapItemNotFound(error)) {
          log.warn(
            "sync.queue",
            `sync error: unable to find item. ${queueKey}`,
          );
          return;
        }
        if (isSyncRateLimitError(error)) {
          this.log.error(
            "sync.queue",
            `sync rate limiting error: ${error.code}`,
          );
          return;
        }

        this.log.error("sync.queue", `Queue ${queueKey} error:`, error);
      });

      this.queues.set(queueKey, queue);
    }

    return queue;
  };

  private cleanupQueue = (queue: PQueue, queueKey: string): void => {
    if (queue.size !== 0 || queue.pending !== 0) return; // do nothing if queue has items pending

    queue.removeAllListeners();
    this.queues.delete(queueKey);
  };
}

function isSyncMapItemNotFound(error: any) {
  return (
    typeof error === "object" &&
    "status" in error &&
    "code" in error &&
    error.status === 404 &&
    error.code === 54201
  );
}

function isSyncRateLimitError(error: any) {
  return (
    typeof error === "object" &&
    "status" in error &&
    "code" in error &&
    error.status === 429 &&
    error.code === 54009
  );
}

/****************************************************
   REST API Methods
  ****************************************************/
/**
 * Updates the status of a Twilio Sync Map Item that holds the "call" details.
 *
 * This function fetches the current call details from a Twilio Sync Map, preserves all existing call data, and updates only the status field.
 * Each call has its own dedicated Sync Map identified by the callSid
 *
 * @param {string} callSid - The unique identifier of the Twilio call to update
 * @param {string} status - The new status for the call
 */
export async function updateCallStatus(
  callSid: string,
  status:
    | "queued"
    | "ringing"
    | "in-progress"
    | "completed"
    | "busy"
    | "failed"
    | "no-answer",
) {
  const client = twilio(TWILIO_API_KEY, TWILIO_API_SECRET, { accountSid });

  const syncMapItemApi = client.sync.v1
    .services(TWILIO_SYNC_SVC_SID)
    .syncMaps(makeContextMapName(callSid))
    .syncMapItems("call");

  const oldData = await syncMapItemApi
    .fetch()
    .then((res) => res.data as CallDetails);

  const data = { ...oldData, status };

  return await syncMapItemApi.update({ data });
}
