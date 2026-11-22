// The package entry is all a fork sees (I05-R1): what its files use, and no boot function.
export { runShell } from "./shell-main.ts";
export { runSiteCheck } from "./site-check-main.ts";
export type { ConnectorFactory, ConnectorInstanceConfig } from "./connectors.ts";
export {
  checkSiteRegistration,
  publicSite,
  type SiteRegistration,
  type SiteRegistrationCode,
} from "./site-registration.ts";
