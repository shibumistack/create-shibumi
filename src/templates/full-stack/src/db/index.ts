// App-side database singleton. Importing this module opens DB_PATH; tooling
// that must not touch the live database (db:restore) imports openDatabase
// from ./lifecycle instead, which is side-effect free.
import { drizzle } from "drizzle-orm/bun-sqlite";
import { loadEnv } from "../env";
import { openDatabase } from "./lifecycle";
import * as schema from "./schema";

const env = loadEnv();
export const sqlite = openDatabase(env.DB_PATH);
export const db = drizzle(sqlite, { schema });
