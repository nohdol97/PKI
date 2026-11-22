// `site-check <kind>` (V01-R18, I01-R1, I05-R1, R19): initializes one Connector kind of a registration
// and reports the outcome. The public entry (`site-check.ts`) hands it the empty registration; a
// deployment fork's own entry hands it its registration. The public repository's site kinds fail with
// the follow-up notice and exit 1, as does a kind of another Connector SDK version
// (`unsupported-sdk-version`); an unknown kind exits 2. In a tree that has a composition package the
// public command only points at the fork's command (the placeholder's notice would mislead).
// The repository root is an argument (I05-R25): nothing here reads the real checkout by itself.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { productConnectors } from "./composition.ts";
import { bindConnectorScopes } from "./connector-scopes.ts";
import { siteCheck } from "./connectors.ts";
import {
  mergeSiteRegistration,
  publicSite,
  stoppingError,
  type SiteRegistration,
} from "./site-registration.ts";

/** Where the lines go and how the exit code is set; the process's own by default, the test's own in tests. */
export interface SiteCheckIo {
  stdout(line: string): void;
  stderr(line: string): void;
  exitCode(code: number): void;
}

const processIo: SiteCheckIo = {
  stdout: (line) => void process.stdout.write(`${line}\n`),
  stderr: (line) => void process.stderr.write(`${line}\n`),
  exitCode: (code) => void (process.exitCode = code),
};

/**
 * The scope value the example package's range file carries (I07-R8): a made-up value the public code
 * reserves, so a fork that copied the example without filling it in is told. Provisional.
 */
export const EXAMPLE_SCOPE_MARKER = "pki-example-scope";

/** The command's argument that asks about the registration's instance scopes instead of one kind (I07-R6). */
const SCOPES_ARG = "--scopes";

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * The fork's command to run instead, when `root` has a composition package (`site/composition/package.json`);
 * undefined when it has none. The package's own `name` is read, never written here (the public code does
 * not know the fork's package names, I05-R4); a name that is missing or not package-shaped gives a message
 * without one.
 */
export function siteCheckGuidance(root: string): string | undefined {
  const file = join(root, "site/composition/package.json");
  if (!existsSync(file)) return undefined;
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(file, "utf8")) as { name?: unknown }).name;
  } catch {
    name = undefined;
  }
  const command =
    typeof name === "string" && PACKAGE_NAME.test(name)
      ? `pnpm --filter ${name} site-check <종류>`
      : "`site/composition`의 `site-check`를 실행하세요 (그 패키지의 `site-check` 스크립트)";
  return `이 저장소에는 배포처 조립 패키지(site/composition)가 있습니다. 공용 site-check는 자리표시만 확인하므로 실행하지 않습니다. 대신 ${command}`;
}

/** The registration's instance scope state (I07-R6): counts and states only, never a scope value or an instance id. */
function reportScopes(site: SiteRegistration, io: SiteCheckIo): void {
  const bound = bindConnectorScopes(site.connectorScopes);
  const fail = (line: string): void => {
    io.stderr(`${SCOPES_ARG}: ${line}`);
    io.exitCode(1);
  };
  if (bound.state === "absent") {
    fail("미구현, 배포처 후속 (S30: 범위 파일을 채우고 등록의 connectorScopes에 묶는다)");
  } else if (bound.state === "invalid") {
    fail("connectorScopes가 객체가 아니다 (connector-scopes-field-invalid)");
  } else if (bound.rejected > 0) {
    fail(`틀린 항목 ${bound.rejected}개 (connector-scopes-entry-invalid)`);
  } else if ([...bound.scopes.values()].some((scope) => scope?.includes(EXAMPLE_SCOPE_MARKER))) {
    fail("예시 값이 그대로다 (채우지 않은 예시의 범위 값)");
  } else if (bound.configured === 0) {
    fail(`범위가 있는 항목이 없다 (항목 ${bound.entries}개)`);
  } else {
    io.stdout(`${SCOPES_ARG}: 항목 ${bound.entries}개, 범위가 있는 항목 ${bound.configured}개`);
  }
}

/** Initializes the kind named in `args` of `site`'s kinds over the product's. */
export async function runSiteCheck(
  site: SiteRegistration,
  args: readonly string[],
  io: SiteCheckIo = processIo,
): Promise<void> {
  const { connectors, violations } = mergeSiteRegistration(site, productConnectors());
  const refused = stoppingError(violations);
  if (refused) {
    io.stderr(refused.message);
    io.exitCode(1);
    return;
  }
  if (args[0] === SCOPES_ARG) {
    reportScopes(site, io);
    return;
  }
  const { kinds } = connectors;
  const kind = args[0] ?? "";
  const create = Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
  if (!create) {
    io.stderr(`usage: site-check <${Object.keys(kinds).join("|")}>`);
    io.exitCode(2);
    return;
  }
  const { ok, line } = await siteCheck(kind, create);
  if (ok) {
    io.stdout(line);
  } else {
    io.stderr(line);
    io.exitCode(1);
  }
}

/** The public command: the fork's command is named when `root` has a composition package, else the placeholders are checked. */
export async function publicSiteCheck(
  root: string,
  args: readonly string[],
  io: SiteCheckIo = processIo,
): Promise<void> {
  const guidance = siteCheckGuidance(root);
  if (guidance !== undefined) {
    io.stderr(guidance);
    io.exitCode(2);
    return;
  }
  await runSiteCheck(publicSite, args, io);
}
