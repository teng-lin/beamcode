import { useCallback, useEffect, useRef, useState } from "react";
import type { FlowMessage } from "../components/MessagePill";
import { addFlowInboundListener, addFlowOutboundListener } from "../ws";

export const MAX_FLOW_MESSAGES = 500;

interface UseMessageFlowResult {
  messages: FlowMessage[];
  paused: boolean;
  pendingCount: number;
  setPaused: (v: boolean) => void;
  clear: () => void;
}

export function useMessageFlow(sessionId: string | null): UseMessageFlowResult {
  const [, setTick] = useState(0);
  const [paused, setPausedState] = useState(false);

  const bufferRef = useRef<FlowMessage[]>([]);
  const pendingRef = useRef<FlowMessage[]>([]);
  const pausedRef = useRef(false);
  const sessionStartRef = useRef<number | null>(null);
  const pairingIndexRef = useRef(new Map<string, string>());

  const forceRender = useCallback(() => setTick((n) => n + 1), []);

  const appendToBuffer = useCallback((msg: FlowMessage) => {
    const buf = bufferRef.current;
    if (buf.length >= MAX_FLOW_MESSAGES) {
      buf.shift();
    }
    buf.push(msg);
  }, []);

  const buildFlowMessage = useCallback(
    (direction: "in" | "out", type: string, payload: unknown): FlowMessage => {
      const now = Date.now();
      if (sessionStartRef.current === null) {
        sessionStartRef.current = now;
      }
      return {
        id: crypto.randomUUID(),
        direction,
        type,
        payload,
        wallTime: now,
        timestamp: now - sessionStartRef.current,
      };
    },
    [],
  );

  const handlePairing = useCallback((msg: FlowMessage) => {
    const index = pairingIndexRef.current;
    const p = msg.payload as Record<string, unknown>;

    if (msg.direction === "in" && msg.type === "permission_response") {
      const requestId = p.request_id as string | undefined;
      if (requestId) {
        const pairedFlowId = index.get(requestId);
        if (pairedFlowId) {
          msg.pairedId = pairedFlowId;
          const partner = bufferRef.current.find((m) => m.id === pairedFlowId);
          if (partner) partner.pairedId = msg.id;
          // Also check pending
          const pendingPartner = pendingRef.current.find((m) => m.id === pairedFlowId);
          if (pendingPartner) pendingPartner.pairedId = msg.id;
        }
      }
    }

    if (msg.direction === "out" && msg.type === "permission_request") {
      const request = p.request as Record<string, unknown> | undefined;
      const requestId = request?.id as string | undefined;
      if (requestId) {
        index.set(requestId, msg.id);
      }
    }
  }, []);

  const ingest = useCallback(
    (msg: FlowMessage) => {
      handlePairing(msg);
      if (pausedRef.current) {
        pendingRef.current.push(msg);
        forceRender();
      } else {
        appendToBuffer(msg);
        forceRender();
      }
    },
    [handlePairing, appendToBuffer, forceRender],
  );

  const setPaused = useCallback(
    (v: boolean) => {
      pausedRef.current = v;
      setPausedState(v);
      if (!v) {
        // Flush pending into ring buffer
        for (const msg of pendingRef.current) {
          appendToBuffer(msg);
        }
        pendingRef.current = [];
        forceRender();
      }
    },
    [appendToBuffer, forceRender],
  );

  const clear = useCallback(() => {
    bufferRef.current = [];
    pendingRef.current = [];
    sessionStartRef.current = null;
    pairingIndexRef.current.clear();
    forceRender();
  }, [forceRender]);

  useEffect(() => {
    if (!sessionId) return;

    const removeInbound = addFlowInboundListener((sid, msg) => {
      if (sid !== sessionId) return;

      // Handle translation events separately to populate boundary metadata
      if (msg.type === "translation_event") {
        const evt = msg as {
          type: "translation_event";
          boundary: "T1" | "T2" | "T3" | "T4";
          translator: string;
          from: { format: string; body: unknown };
          to: { format: string; body: unknown };
          traceId?: string;
          timestamp: number;
          sessionId: string;
        };
        // T1/T2 = consumer→backend path (right/inbound column)
        // T3/T4 = backend→consumer path (left/outbound column)
        const direction = evt.boundary === "T1" || evt.boundary === "T2" ? "in" : "out";
        const flowMsg = buildFlowMessage(direction, evt.boundary, evt.to.body);
        flowMsg.boundary = evt.boundary;
        flowMsg.translator = evt.translator;
        flowMsg.nativeFormat = evt.from;
        flowMsg.traceId = evt.traceId;
        ingest(flowMsg);
      } else {
        // Regular consumer message — bridge→consumer = left/outbound column
        const flowMsg = buildFlowMessage("out", msg.type, msg);
        ingest(flowMsg);
      }
    });

    const removeOutbound = addFlowOutboundListener((sid, msg) => {
      if (sid !== sessionId) return;
      // consumer→bridge = right/inbound column
      const flowMsg = buildFlowMessage("in", msg.type, msg);
      ingest(flowMsg);
    });

    return () => {
      removeInbound();
      removeOutbound();
    };
  }, [sessionId, buildFlowMessage, ingest]);

  return {
    messages: bufferRef.current,
    paused,
    pendingCount: pendingRef.current.length,
    setPaused,
    clear,
  };
}
