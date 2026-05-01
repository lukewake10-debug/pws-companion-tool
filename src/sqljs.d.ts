declare module "sql.js" {
  export interface SqlJsConfig {
    locateFile?: (file: string) => string;
  }

  export interface Database {
    exec(sql: string): Array<{
      columns: string[];
      values: unknown[][];
    }>;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}

declare module "sql.js/dist/sql-asm.js" {
  export { default } from "sql.js";
}
