export const APP_BASE_NAME = "Vibeinator";
const isCanaryDesktop =
  typeof window !== "undefined" && window.location?.protocol === "vibeinator-canary:";
const isBetaDesktop =
  typeof window !== "undefined" && window.location?.protocol === "vibeinator-beta:";
export const APP_DISPLAY_NAME = isCanaryDesktop
  ? "Vibeinator Canary"
  : isBetaDesktop
    ? "Vibeinator Beta"
    : import.meta.env.DEV
      ? `${APP_BASE_NAME} (Dev)`
      : APP_BASE_NAME;
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
