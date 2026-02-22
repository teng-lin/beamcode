import type { BridgeEventMap } from "../../types/events.js";
import type { ConsumerBroadcaster } from "../consumer-broadcaster.js";
import type { MessageTracer } from "../message-tracer.js";
import {
  AdapterNativeHandler,
  LocalHandler,
  PassthroughHandler,
  SlashCommandChain,
  UnsupportedHandler,
} from "../slash-command-chain.js";
import { SlashCommandExecutor } from "../slash-command-executor.js";
import { SlashCommandService } from "../slash-command-service.js";

type EmitEvent = (
  type: keyof BridgeEventMap,
  payload: BridgeEventMap[keyof BridgeEventMap],
) => void;

type PassthroughDeps = ConstructorParameters<typeof PassthroughHandler>[0];

export function createSlashService(params: {
  broadcaster: ConsumerBroadcaster;
  emitEvent: EmitEvent;
  tracer: MessageTracer;
  now: () => number;
  generateTraceId: () => string;
  generateSlashRequestId: () => string;
  registerPendingPassthrough: PassthroughDeps["registerPendingPassthrough"];
  sendUserMessage: PassthroughDeps["sendUserMessage"];
}): SlashCommandService {
  const localHandler = new LocalHandler({
    executor: new SlashCommandExecutor(),
    broadcaster: params.broadcaster,
    emitEvent: params.emitEvent,
    tracer: params.tracer,
  });

  const commandChain = new SlashCommandChain([
    localHandler,
    new AdapterNativeHandler({
      broadcaster: params.broadcaster,
      emitEvent: params.emitEvent,
      tracer: params.tracer,
    }),
    new PassthroughHandler({
      broadcaster: params.broadcaster,
      emitEvent: params.emitEvent,
      registerPendingPassthrough: params.registerPendingPassthrough,
      sendUserMessage: params.sendUserMessage,
      tracer: params.tracer,
    }),
    new UnsupportedHandler({
      broadcaster: params.broadcaster,
      emitEvent: params.emitEvent,
      tracer: params.tracer,
    }),
  ]);

  return new SlashCommandService({
    tracer: params.tracer,
    now: params.now,
    generateTraceId: params.generateTraceId,
    generateSlashRequestId: params.generateSlashRequestId,
    commandChain,
    localHandler,
  });
}
