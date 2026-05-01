import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = resolve("node_modules/sql.js/dist/sql-wasm.wasm");
const destination = resolve("public/sql-wasm.wasm");

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
