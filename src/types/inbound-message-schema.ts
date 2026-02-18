import { z } from "zod";

const imageSchema = z.object({
  media_type: z.string(),
  data: z.string(),
});

const permissionDestinationSchema = z.enum(["userSettings", "projectSettings"]);

const ruleSchema = z.object({
  toolName: z.string(),
  ruleContent: z.string().optional(),
});

const permissionUpdateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("addRules"),
    rules: z.array(ruleSchema),
    behavior: z.enum(["allow", "deny", "ask"]),
    destination: permissionDestinationSchema,
  }),
  z.object({
    type: z.literal("replaceRules"),
    rules: z.array(ruleSchema),
    behavior: z.enum(["allow", "deny", "ask"]),
    destination: permissionDestinationSchema,
  }),
  z.object({
    type: z.literal("removeRules"),
    rules: z.array(ruleSchema),
    behavior: z.enum(["allow", "deny", "ask"]),
    destination: permissionDestinationSchema,
  }),
  z.object({
    type: z.literal("setMode"),
    mode: z.string(),
    destination: permissionDestinationSchema,
  }),
  z.object({
    type: z.literal("addDirectories"),
    directories: z.array(z.string()),
    destination: permissionDestinationSchema,
  }),
  z.object({
    type: z.literal("removeDirectories"),
    directories: z.array(z.string()),
    destination: permissionDestinationSchema,
  }),
]);

export const inboundMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user_message"),
    content: z.string(),
    session_id: z.string().optional(),
    images: z.array(imageSchema).optional(),
  }),
  z.object({
    type: z.literal("permission_response"),
    request_id: z.string(),
    behavior: z.enum(["allow", "deny"]),
    updated_input: z.record(z.unknown()).optional(),
    updated_permissions: z.array(permissionUpdateSchema).optional(),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal("interrupt") }),
  z.object({ type: z.literal("set_model"), model: z.string() }),
  z.object({ type: z.literal("set_permission_mode"), mode: z.string() }),
  z.object({ type: z.literal("presence_query") }),
  z.object({
    type: z.literal("slash_command"),
    command: z.string(),
    request_id: z.string().optional(),
  }),
  z.object({ type: z.literal("set_adapter"), adapter: z.string() }),
  z.object({
    type: z.literal("queue_message"),
    content: z.string(),
    images: z.array(imageSchema).optional(),
  }),
  z.object({
    type: z.literal("update_queued_message"),
    content: z.string(),
    images: z.array(imageSchema).optional(),
  }),
  z.object({ type: z.literal("cancel_queued_message") }),
]);
