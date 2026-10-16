import { describe, expect, it, vi } from "vitest";

import { type ReceiptStreamReadyEvent } from "@lumenbazaar/shared";

import { ReceiptStatusStreamSession, type StreamSink } from "./streamSession.js";

function createFakeSink(initialWritable: boolean) {
  const writes: string[] = [];
  let writable = initialWritable;
  let ended = false;
  let drainListener: (() => void) | undefined;
  let closeListener: (() => void) | undefined;

  const sink: StreamSink = {
    write: (chunk) => {
      writes.push(chunk);
      return writable;
    },
    end: () => {
      ended = true;
    },
    onDrain: (listener) => {
      drainListener = listener;
      return () => {
        if (drainListener === listener) {
          drainListener = undefined;
        }
      };
    },
    onClose: (listener) => {
      closeListener = listener;
      return () => {
        if (closeListener === listener) {
          closeListener = undefined;
        }
      };
    }
  };

  return {
    sink,
    writes,
    get ended() {
      return ended;
    },
    setWritable(value: boolean) {
      writable = value;
    },
    drain() {
      drainListener?.();
    },
    close() {
      closeListener?.();
    }
  };
}

function readyEvent(overrides: Partial<ReceiptStreamReadyEvent> = {}): ReceiptStreamReadyEvent {
  return {
    scope: { kind: "receipt", id: "receipt_session" },
    cursor: "lbsc1.session.0",
    heartbeatIntervalMs: 10_000,
    finalStatuses: ["finalized", "failed"],
    ...overrides
  };
}

function createSession(
  fake: ReturnType<typeof createFakeSink>,
  options: { heartbeatIntervalMs?: number; maxPendingEvents?: number; authorized?: boolean } = {}
) {
  let authorized = options.authorized ?? true;
  const onClosed = vi.fn();
  const session = new ReceiptStatusStreamSession({
    sink: fake.sink,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
    maxPendingEvents: options.maxPendingEvents ?? 4,
    isAuthorized: () => authorized,
    onClosed
  });

  return {
    session,
    onClosed,
    revoke() {
      authorized = false;
    }
  };
}

describe("ReceiptStatusStreamSession", () => {
  it("ends with a backpressure reason when the pending queue overflows", () => {
    const fake = createFakeSink(false);
    const { session, onClosed } = createSession(fake, { maxPendingEvents: 3 });

    session.start(readyEvent());
    expect(session.isOpen).toBe(true);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]).toContain("retry: 2000");

    session.deliver(1, "receipt.status", { status: "pending" });
    session.deliver(2, "receipt.status", { status: "confirmed" });
    session.deliver(3, "receipt.status", { status: "finalized" });

    expect(session.isOpen).toBe(false);
    expect(fake.ended).toBe(true);
    expect(onClosed).toHaveBeenCalledOnce();
    expect(fake.writes.at(-1)).toContain('"reason":"backpressure"');

    session.deliver(4, "receipt.status", { status: "finalized" });
    expect(fake.writes.at(-1)).toContain('"reason":"backpressure"');
  });

  it("flushes queued frames in order once the sink drains", () => {
    const fake = createFakeSink(false);
    const { session } = createSession(fake);

    session.start(readyEvent());
    session.deliver(1, "receipt.status", { status: "pending" });
    session.deliver(2, "receipt.status", { status: "confirmed" });

    expect(fake.writes).toHaveLength(1);

    fake.setWritable(true);
    fake.drain();

    expect(fake.writes).toHaveLength(4);
    expect(fake.writes[1]).toContain("stream.ready");
    expect(fake.writes[2]).toContain("id: 1");
    expect(fake.writes[3]).toContain("id: 2");
    expect(session.isOpen).toBe(true);
  });

  it("emits heartbeats and ends when authorization is lost", async () => {
    const fake = createFakeSink(true);
    const { session, revoke } = createSession(fake, { heartbeatIntervalMs: 20 });

    session.start(readyEvent());

    await vi.waitFor(() => expect(fake.writes.join("")).toContain(": hb"), {
      timeout: 1_000,
      interval: 10
    });

    revoke();

    await vi.waitFor(
      () => {
        expect(fake.writes.join("")).toContain('"reason":"authorization_expired"');
      },
      { timeout: 1_000, interval: 10 }
    );

    expect(session.isOpen).toBe(false);
    expect(fake.ended).toBe(true);
  });

  it("closes idempotently when the sink closes and stops accepting frames", () => {
    const fake = createFakeSink(true);
    const { session, onClosed } = createSession(fake);

    session.start(readyEvent());
    fake.close();

    expect(session.isOpen).toBe(false);
    expect(fake.ended).toBe(true);
    expect(onClosed).toHaveBeenCalledOnce();

    session.deliver(1, "receipt.status", { status: "pending" });
    session.end("shutdown");

    expect(fake.writes.filter((frame) => frame.includes("receipt.status"))).toHaveLength(0);
    expect(fake.writes.filter((frame) => frame.includes("stream.end"))).toHaveLength(0);
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("ends with a shutdown reason for open sessions", () => {
    const fake = createFakeSink(true);
    const { session } = createSession(fake);

    session.start(readyEvent());
    session.end("shutdown");

    expect(fake.writes.at(-1)).toContain('"reason":"shutdown"');
    expect(fake.ended).toBe(true);
    expect(session.isOpen).toBe(false);
  });
});
