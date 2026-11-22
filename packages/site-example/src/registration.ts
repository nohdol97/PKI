// The example of a deployment fork's registration (I05-R20): what a fork writes in
// site/composition/src/registration.ts, with the public example collector standing in for a real one. It
// is the one file of the package that takes a collector package's `/adapters` entry (the boundary rule's
// composition point, I05-R4). It is not part of the product: nothing public imports this package.
import type { SiteRegistration } from "@pki/backend";
import { createExampleConnector } from "@pki/connector-example/adapters";

/** The collector's kind name is its manifest's `type` (I05-R7). */
const KIND = "connector-example";

export const registration: SiteRegistration = {
  connectorKinds: { [KIND]: createExampleConnector },
  connectorInstances: [
    {
      id: "example-notes",
      kind: KIND,
      config: {
        namespace: "example-notes",
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
            revision: 1,
            updatedAt: "2026-01-06T10:30:00Z",
            title: "Garden plan",
            body: "Tomatoes by the fence.",
          },
        ],
      },
    },
  ],
};
