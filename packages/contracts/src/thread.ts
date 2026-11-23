// The source screen's "same thread" read (I02B-R55): the thread the source version belongs to, in time order.
// The messages carry no text: a message is opened by its version number through the Explore source read.
import { z } from "zod";

export const SourceThreadRequestSchema = z.strictObject({ versionId: z.int().positive() });
export const SourceThreadResponseSchema = z.object({
  messages: z.array(
    z.object({
      versionId: z.int().positive(),
      title: z.string(),
      author: z.string().optional(),
      createdAt: z.string().optional(),
    }),
  ),
  /** `author` and `participants` of the shown messages, in order of first appearance. */
  participants: z.array(z.string()),
});
export type SourceThreadResponse = z.infer<typeof SourceThreadResponseSchema>;
