import { z } from "zod";

/**
 * Names a frame the way a human would describe it, not how a particular
 * driver finds it. The adapter translates this into whatever the surface
 * actually needs — a `page.frameLocator('iframe[title="..."]')` call on
 * web, a window/pane lookup on a future desktop adapter. An artifact must
 * never encode a CSS selector or other driver-specific lookup here; that
 * would make frame targeting the one DOM-brittle thing in an otherwise
 * driver-agnostic schema.
 */
export const FrameRefSchema = z.object({
  by: z.enum(["title", "name", "url"]),
  value: z.string().min(1),
});
export type FrameRef = z.infer<typeof FrameRefSchema>;
