/** Build-time edition switch. "browser" = static GitHub Pages build with the in-browser backend. */
export const BROWSER_EDITION = process.env.NEXT_PUBLIC_EDITION === "browser";
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
export const withBase = (p: string) => `${BASE_PATH}${p}`;
