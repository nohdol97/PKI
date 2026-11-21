// V01-C7 `sql-driver.contract` run against the better-sqlite3 driver.
import { sqlDriverContract } from "@pki/testkit";
import { openBetterSqlite3 } from "./better-sqlite3-driver.ts";

sqlDriverContract("better-sqlite3", openBetterSqlite3);
