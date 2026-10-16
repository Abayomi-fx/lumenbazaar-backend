import {
  type Receipt,
  type ReceiptStreamChange,
  type ReceiptStreamScope,
  type ReceiptStatus
} from "@lumenbazaar/shared";
import { receiptStatusChange, type ReceiptService } from "@lumenbazaar/stellar-payments";

import type { StreamAccessService } from "./streamAccess.js";
import { streamScopeKey, type StreamGrant } from "./streamAccess.js";
import { ReceiptStatusStreamSession, type StreamSink } from "./streamSession.js";

export const receiptStreamFinalStatuses: readonly ReceiptStatus[] = ["finalized", "failed"];

export function isFinalReceiptStatus(status: ReceiptStatus) {
  return status === "finalized" || status === "failed";
}

export type EventStreamTuning = {
  heartbeatIntervalMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  maxPendingEvents?: number | undefined;
  journalSize?: number | undefined;
  journalTtlMs?: number | undefined;
  maxSnapshotReceipts?: number | undefined;
};

export type ReceiptStatusStreamServiceOptions = EventStreamTuning & {
  receiptService: Pick<ReceiptService, "getReceipt" | "listReceiptsBySeller">;
  streamAccess: StreamAccessService;
};

export type AttachStreamOptions = {
  scope: ReceiptStreamScope;
  grant: StreamGrant;
  cursorSeq: number | undefined;
  sink: StreamSink;
  knownReceipt?: Receipt | undefined;
};

type JournalEntry = {
  seq: number;
  change: ReceiptStreamChange;
};

type Journal = {
  scope: ReceiptStreamScope;
  seq: number;
  oldestSeq: number;
  entries: JournalEntry[];
  lastStatuses: Map<string, { seq: number; status: ReceiptStatus }>;
  subscribers: Set<ReceiptStatusStreamSession>;
  lastActivityAt: number;
};

export class ReceiptStatusStreamService {
  readonly receiptService: Pick<ReceiptService, "getReceipt" | "listReceiptsBySeller">;
  readonly streamAccess: StreamAccessService;
  private readonly heartbeatIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxPendingEvents: number;
  private readonly journalSize: number;
  private readonly journalTtlMs: number;
  private readonly maxSnapshotReceipts: number;
  private readonly journals = new Map<string, Journal>();
  private readonly pollTimer: NodeJS.Timeout;
  private polling = false;
  private closed = false;

  constructor(options: ReceiptStatusStreamServiceOptions) {
    this.receiptService = options.receiptService;
    this.streamAccess = options.streamAccess;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.maxPendingEvents = options.maxPendingEvents ?? 32;
    this.journalSize = options.journalSize ?? 64;
    this.journalTtlMs = options.journalTtlMs ?? 300_000;
    this.maxSnapshotReceipts = options.maxSnapshotReceipts ?? 100;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    this.pollTimer.unref();
  }

  publish(change: ReceiptStreamChange) {
    if (this.closed) {
      return;
    }

    const scopes: ReceiptStreamScope[] = [{ kind: "receipt", id: change.receiptId }];
    if (change.sellerId !== null) {
      scopes.push({ kind: "seller", id: change.sellerId });
    }

    for (const scope of scopes) {
      const journal = this.journals.get(streamScopeKey(scope));
      if (journal !== undefined) {
        this.appendAndBroadcast(journal, change);
      }
    }
  }

  async notifyReceipt(receiptId: string) {
    if (this.closed || this.journals.size === 0) {
      return;
    }

    const receipt = await this.receiptService.getReceipt(receiptId).catch(() => undefined);
    if (receipt !== undefined) {
      this.publish(receiptStatusChange(receipt));
    }
  }

  async attach(options: AttachStreamOptions) {
    const journal = this.getOrCreateJournal(options.scope);
    const resetSeq =
      options.cursorSeq !== undefined &&
      (options.cursorSeq > journal.seq || options.cursorSeq < journal.oldestSeq - 1)
        ? journal.seq
        : undefined;

    const session = new ReceiptStatusStreamSession({
      sink: options.sink,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      maxPendingEvents: this.maxPendingEvents,
      isAuthorized: () => Date.now() < options.grant.expiresAt,
      onClosed: () => {
        journal.subscribers.delete(session);
      }
    });
    journal.subscribers.add(session);
    journal.lastActivityAt = Date.now();

    const resumeSeq = resetSeq ?? options.cursorSeq ?? journal.seq;
    session.start({
      scope: options.scope,
      cursor: this.streamAccess.issueCursor(options.scope, resumeSeq),
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      finalStatuses: receiptStreamFinalStatuses
    });

    if (resetSeq !== undefined) {
      session.sendReset(resetSeq, {
        reason: "cursor_unavailable",
        cursor: this.streamAccess.issueCursor(options.scope, resetSeq)
      });
    } else if (options.cursorSeq !== undefined) {
      for (const entry of journal.entries) {
        if (entry.seq > options.cursorSeq) {
          this.deliverEntry(session, journal.scope, entry);
        }
      }
    }

    try {
      if (options.scope.kind === "receipt") {
        const receipt =
          options.knownReceipt ??
          (await this.receiptService.getReceipt(options.scope.id).catch(() => undefined));

        if (receipt === undefined) {
          session.end("authorization_expired");
          return;
        }

        this.syncIfChanged(journal, receipt);

        if (isFinalReceiptStatus(receipt.status)) {
          session.end("final");
        }
      } else {
        const receipts = await this.receiptService.listReceiptsBySeller(
          options.scope.id,
          this.maxSnapshotReceipts
        );
        for (const receipt of receipts) {
          this.syncIfChanged(journal, receipt);
        }
      }
    } catch (error) {
      session.close();
      throw error;
    }
  }

  close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    clearInterval(this.pollTimer);

    for (const journal of [...this.journals.values()]) {
      for (const session of [...journal.subscribers]) {
        session.end("shutdown");
      }
    }

    this.journals.clear();
  }

  private getOrCreateJournal(scope: ReceiptStreamScope): Journal {
    const key = streamScopeKey(scope);
    const existing = this.journals.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const journal: Journal = {
      scope,
      seq: 0,
      oldestSeq: 1,
      entries: [],
      lastStatuses: new Map(),
      subscribers: new Set(),
      lastActivityAt: Date.now()
    };
    this.journals.set(key, journal);
    return journal;
  }

  private append(journal: Journal, change: ReceiptStreamChange): JournalEntry {
    journal.seq += 1;
    const entry: JournalEntry = { seq: journal.seq, change };
    journal.entries.push(entry);
    journal.lastStatuses.set(change.receiptId, { seq: entry.seq, status: change.status });

    while (journal.entries.length > this.journalSize) {
      journal.entries.shift();
      journal.oldestSeq = journal.entries[0]?.seq ?? journal.seq + 1;
    }

    journal.lastActivityAt = Date.now();
    return entry;
  }

  private appendAndBroadcast(journal: Journal, change: ReceiptStreamChange) {
    const known = journal.lastStatuses.get(change.receiptId);
    if (known !== undefined && known.status === change.status) {
      return undefined;
    }

    const entry = this.append(journal, change);

    for (const subscriber of [...journal.subscribers]) {
      this.deliverEntry(subscriber, journal.scope, entry);
    }

    if (journal.scope.kind === "receipt" && isFinalReceiptStatus(change.status)) {
      for (const subscriber of [...journal.subscribers]) {
        subscriber.end("final");
      }
    }

    return entry;
  }

  private syncIfChanged(journal: Journal, receipt: Receipt) {
    const known = journal.lastStatuses.get(receipt.id);
    if (known !== undefined && known.status === receipt.status) {
      return;
    }

    this.appendAndBroadcast(journal, receiptStatusChange(receipt));
  }

  private deliverEntry(
    session: ReceiptStatusStreamSession,
    scope: ReceiptStreamScope,
    entry: JournalEntry
  ) {
    const cursor = this.streamAccess.issueCursor(scope, entry.seq);
    session.deliver(entry.seq, "receipt.status", { ...entry.change, cursor }, cursor);
  }

  private async poll() {
    if (this.closed || this.polling) {
      return;
    }

    this.polling = true;
    try {
      const now = Date.now();

      for (const [key, journal] of [...this.journals]) {
        if (journal.subscribers.size === 0) {
          if (now - journal.lastActivityAt > this.journalTtlMs) {
            this.journals.delete(key);
          }
          continue;
        }

        if (journal.scope.kind === "receipt") {
          const receipt = await this.receiptService
            .getReceipt(journal.scope.id)
            .catch(() => undefined);
          if (this.closed) {
            return;
          }
          if (receipt !== undefined) {
            this.syncIfChanged(journal, receipt);
          }
          continue;
        }

        const receipts = await this.receiptService
          .listReceiptsBySeller(journal.scope.id, this.maxSnapshotReceipts)
          .catch(() => [] as Receipt[]);
        if (this.closed) {
          return;
        }
        for (const receipt of receipts) {
          this.syncIfChanged(journal, receipt);
        }
      }
    } finally {
      this.polling = false;
    }
  }
}
