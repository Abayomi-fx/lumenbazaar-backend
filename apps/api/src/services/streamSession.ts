import type {
  ReceiptStreamEndReason,
  ReceiptStreamReadyEvent,
  ReceiptStreamResetEvent
} from "@lumenbazaar/shared";

export type StreamSink = {
  write: (chunk: string) => boolean;
  end: () => void;
  onDrain: (listener: () => void) => () => void;
  onClose: (listener: () => void) => () => void;
};

export type ReceiptStatusStreamSessionOptions = {
  sink: StreamSink;
  heartbeatIntervalMs: number;
  maxPendingEvents: number;
  isAuthorized: () => boolean;
  onClosed?: (() => void) | undefined;
};

export class ReceiptStatusStreamSession {
  private readonly sink: StreamSink;
  private readonly heartbeatIntervalMs: number;
  private readonly maxPendingEvents: number;
  private readonly isAuthorized: () => boolean;
  private readonly onClosed: (() => void) | undefined;
  private readonly pending: string[] = [];
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private unsubscribeDrain: (() => void) | undefined;
  private unsubscribeClose: (() => void) | undefined;
  private waitingForDrain = false;
  private lastDeliveredSeq = 0;
  private started = false;
  private closed = false;

  constructor(options: ReceiptStatusStreamSessionOptions) {
    this.sink = options.sink;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.maxPendingEvents = options.maxPendingEvents;
    this.isAuthorized = options.isAuthorized;
    this.onClosed = options.onClosed;
    this.unsubscribeClose = this.sink.onClose(() => this.close());
  }

  get isOpen() {
    return !this.closed;
  }

  start(ready: ReceiptStreamReadyEvent) {
    if (this.closed || this.started) {
      return;
    }

    this.started = true;
    this.enqueue("retry: 2000\n\n");
    this.enqueue(renderFrame("stream.ready", undefined, ready));
    this.startHeartbeat();
  }

  deliver(seq: number, name: string, data: unknown, id: string | number = seq) {
    if (this.closed || seq <= this.lastDeliveredSeq) {
      return;
    }

    if (!this.isAuthorized()) {
      this.end("authorization_expired");
      return;
    }

    this.lastDeliveredSeq = seq;
    this.enqueue(renderFrame(name, id, data));
  }

  sendReset(seq: number, event: ReceiptStreamResetEvent) {
    if (this.closed) {
      return;
    }

    this.lastDeliveredSeq = seq;
    this.enqueue(renderFrame("stream.reset", event.cursor, event));
  }

  end(reason: ReceiptStreamEndReason) {
    if (this.closed) {
      return;
    }

    this.flushPending();
    this.sink.write(renderFrame("stream.end", undefined, { reason }));
    this.finish();
  }

  close() {
    if (this.closed) {
      return;
    }

    this.finish();
  }

  private finish() {
    this.closed = true;
    this.pending.length = 0;
    this.waitingForDrain = false;
    this.unsubscribeDrain?.();
    this.unsubscribeDrain = undefined;
    this.unsubscribeClose?.();
    this.unsubscribeClose = undefined;
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.sink.end();
    this.onClosed?.();
  }

  private enqueue(frame: string) {
    if (this.closed) {
      return;
    }

    if (this.waitingForDrain || this.pending.length > 0) {
      this.pending.push(frame);
    } else if (!this.sink.write(frame)) {
      this.waitingForDrain = true;
      this.unsubscribeDrain = this.sink.onDrain(() => this.flush());
    }

    if (this.pending.length > this.maxPendingEvents) {
      this.overload();
    }
  }

  private flush() {
    if (this.closed) {
      return;
    }

    this.unsubscribeDrain?.();
    this.unsubscribeDrain = undefined;
    this.waitingForDrain = false;

    while (this.pending.length > 0) {
      const frame = this.pending.shift();
      if (frame === undefined) {
        break;
      }
      if (!this.sink.write(frame)) {
        this.waitingForDrain = true;
        this.unsubscribeDrain = this.sink.onDrain(() => this.flush());
        break;
      }
    }
  }

  private flushPending() {
    this.unsubscribeDrain?.();
    this.unsubscribeDrain = undefined;
    this.waitingForDrain = false;

    while (this.pending.length > 0) {
      const frame = this.pending.shift();
      if (frame !== undefined) {
        this.sink.write(frame);
      }
    }
  }

  private overload() {
    this.pending.length = 0;
    this.sink.write(renderFrame("stream.end", undefined, { reason: "backpressure" }));
    this.finish();
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (!this.isAuthorized()) {
        this.end("authorization_expired");
        return;
      }
      this.enqueue(`: hb ${new Date().toISOString()}\n\n`);
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }
}

function renderFrame(name: string | undefined, id: string | number | undefined, data: unknown) {
  const lines: string[] = [];

  if (id !== undefined) {
    lines.push(`id: ${id}`);
  }
  if (name !== undefined) {
    lines.push(`event: ${name}`);
  }
  lines.push(`data: ${JSON.stringify(data)}`);

  return `${lines.join("\n")}\n\n`;
}
