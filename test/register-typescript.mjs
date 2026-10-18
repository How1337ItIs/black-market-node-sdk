import { register } from "node:module";

register("./typescript-loader.mjs", import.meta.url);
// Absolute URL also works for CLI child processes launched from disposable directories.
export const typescriptNodeArgs = ["--import", import.meta.url];
