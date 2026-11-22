// The process the ledger crash test kills (I04-R17, ledger.boot-reconcile). It opens the
// canonical database and ledger of a data directory the way the backend does, then deletes
// a source through the product's entry. The ledger's file adapter kills this process
// (SIGKILL) as soon as a line has been written and fsynced, which is before COMMIT: the
// real state a crash there leaves. Run by `node` directly (type stripping), never bundled
// and never run by the suite (its name is outside the suite's pattern).
import { userDelete } from "@pki/knowledge-engine";
import {
  LEDGER_FILE,
  attachLedger,
  nodeLedgerIo,
  openLedger,
  prepareCanonicalDb,
  readKey,
  readLedgerSeq,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { join } from "node:path";

const dir = process.env.PKI_KILL_DATA_DIR;
if (dir === undefined) throw new Error("PKI_KILL_DATA_DIR is not set");
const externalId = process.env.PKI_KILL_EXTERNAL_ID ?? "chat";

const db = openBetterSqlite3(join(dir, "pki.sqlite"));
prepareCanonicalDb(db);
attachLedger(
  db,
  openLedger({
    path: join(dir, LEDGER_FILE),
    key: readKey(db) as Uint8Array,
    canonicalSeq: readLedgerSeq(db),
    hasData: true,
    io: {
      ...nodeLedgerIo,
      append: (path, text) => {
        nodeLedgerIo.append(path, text);
        if (text.includes('"t":"line"')) process.kill(process.pid, "SIGKILL");
      },
    },
  }),
);
userDelete(
  db,
  { connectorInstanceId: "c1", namespace: "n", externalId },
  "2026-11-22T00:00:00.000Z",
);
// reaching here means no line was written: the parent test fails on the exit status
process.exit(3);
