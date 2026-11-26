import { z } from "zod";

const MAX_MATCH_SOURCE = 512;
const MAX_REPLACEMENT = 8192;
const MAX_EMPTY_FALLBACK = 2048;

export const responseProcessorConditionSchema = z
  .object({
    type: z.enum(["contains", "not-contains"]),
    value: z.string().trim().min(1).max(MAX_MATCH_SOURCE),
    caseSensitive: z.boolean().optional(),
  })
  .strict();

export const responseProcessorRuleSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    label: z.string().trim().max(120).optional(),
    enabled: z.boolean(),
    match: z.string().min(1).max(MAX_MATCH_SOURCE),
    matchType: z.enum(["literal", "regex"]),
    caseSensitive: z.boolean().optional(),
    anchor: z.enum(["anywhere", "start", "whole-response"]),
    action: z.enum(["replace", "remove", "replace-whole-response"]),
    replaceWith: z.string().max(MAX_REPLACEMENT).optional(),
    conditions: z.array(responseProcessorConditionSchema).max(20).optional(),
    collapseWhitespace: z.boolean().optional(),
    maxMatchLength: z.number().int().positive().max(4096).optional(),
  })
  .strict();

export const updateResponseProcessorSchema = z
  .object({
    enabled: z.boolean().optional(),
    rules: z.array(responseProcessorRuleSchema).max(500).optional(),
    /** Reply used when a rule set removes an answer down to nothing. Blank keeps it empty. */
    emptyFallback: z.string().max(MAX_EMPTY_FALLBACK).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.enabled !== undefined || value.rules !== undefined || value.emptyFallback !== undefined,
    {
      message: "No valid fields to update",
    }
  );

export const previewResponseProcessorSchema = z
  .object({
    text: z.string().max(200_000).optional(),
    body: z.unknown().optional(),
    /** Unsaved rules from the editor; omit to preview the saved configuration. */
    rules: z.array(responseProcessorRuleSchema).max(500).optional(),
    /** Unsaved empty-response reply, previewed alongside the unsaved rules. */
    emptyFallback: z.string().max(MAX_EMPTY_FALLBACK).optional(),
  })
  .strict()
  .refine((value) => value.text !== undefined || value.body !== undefined, {
    message: "Provide text or body to preview",
  });

export type UpdateResponseProcessorInput = z.infer<typeof updateResponseProcessorSchema>;
