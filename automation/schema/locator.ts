import { z } from "zod";

/**
 * The four locator strategies, tried in order at replay (CLAUDE.md's
 * Perception Model). Every entry carries a `rationale` explaining why it
 * was chosen; the two brittle strategies must say so structurally, not by
 * convention.
 */
export const RoleNameLocatorSchema = z.object({
  kind: z.literal("role"),
  role: z.string().min(1),
  name: z.string().min(1),
  exact: z.boolean().default(true),
  /**
   * Disambiguates repeated role+name matches (0-indexed), the "nth" in
   * CLAUDE.md's "resolve refs via role+name+nth within the frame." Omitted
   * when the role+name pair is already unique — most hand-authored
   * locators never need it; it exists for `resolveRef` (adapter phase),
   * which fills it in only when the snapshot shows more than one match.
   */
  nth: z.number().int().nonnegative().optional(),
  rationale: z.string().min(1),
});

export const LabelLocatorSchema = z.object({
  kind: z.literal("label"),
  text: z.string().min(1),
  exact: z.boolean().default(true),
  rationale: z.string().min(1),
});

/** Structural position, e.g. the cell in the row whose row header matches. */
export const StructuralLocatorSchema = z.object({
  kind: z.literal("structural"),
  description: z.string().min(1),
  rowHeader: z.string().min(1),
  rationale: z.string().min(1),
});

export const CssLocatorSchema = z.object({
  kind: z.literal("css"),
  selector: z.string().min(1),
  brittle: z.literal(true),
  rationale: z.string().min(1),
});

export const XPathLocatorSchema = z.object({
  kind: z.literal("xpath"),
  expression: z.string().min(1),
  brittle: z.literal(true),
  rationale: z.string().min(1),
});

export const LocatorStrategySchema = z.discriminatedUnion("kind", [
  RoleNameLocatorSchema,
  LabelLocatorSchema,
  StructuralLocatorSchema,
  CssLocatorSchema,
  XPathLocatorSchema,
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

export const LocatorChainSchema = z.array(LocatorStrategySchema).min(1);
export type LocatorChain = z.infer<typeof LocatorChainSchema>;
