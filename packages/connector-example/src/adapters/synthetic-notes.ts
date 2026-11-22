// Made-up notes (I01-R27): the example's origin system at two moments. Nothing
// here comes from a real system.
import type { ExampleConfig } from "./example-connector.ts";

const NAMESPACE = "example-notes";

/** The origin as first read: three notes, and one it already marks deleted. */
export const EARLIER: ExampleConfig = {
  namespace: NAMESPACE,
  notes: [
    {
      id: "note-1",
      seq: 1,
      revision: 1,
      updatedAt: "2026-01-05T09:00:00Z",
      title: "Reading list",
      body: "Three made-up books about lighthouses.",
    },
    {
      id: "note-2",
      seq: 2,
      revision: 3,
      updatedAt: "2026-01-06T10:30:00Z",
      title: "Garden plan",
      body: "Tomatoes by the fence.",
    },
    { id: "note-3", seq: 3, revision: 2, updatedAt: "2026-01-07T08:15:00Z", deleted: true },
    {
      id: "note-4",
      seq: 4,
      revision: 1,
      updatedAt: "2026-01-08T14:00:00Z",
      title: "Trip packing",
      body: "Boots, map, flask.",
    },
  ],
};

/** The same origin later: note-2 edited, note-4 deleted, note-5 new. */
export const LATER: ExampleConfig = {
  namespace: NAMESPACE,
  notes: [
    ...EARLIER.notes.filter(({ id }) => id === "note-1" || id === "note-3"),
    {
      id: "note-2",
      seq: 5,
      revision: 4,
      updatedAt: "2026-02-01T10:00:00Z",
      title: "Garden plan",
      body: "Tomatoes by the fence, beans by the gate.",
    },
    { id: "note-4", seq: 6, revision: 2, updatedAt: "2026-02-02T11:00:00Z", deleted: true },
    {
      id: "note-5",
      seq: 7,
      revision: 1,
      updatedAt: "2026-02-03T12:00:00Z",
      title: "Recipe",
      body: "Bread with too much salt.",
    },
  ],
};
