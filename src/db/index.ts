import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import { env } from '../config/env.js';

const client = postgres(env.DATABASE_URL, {
  ssl: env.NODE_ENV === 'production' ? 'require' : false,
});
export const db = drizzle(client, { schema });

export type DB = typeof db;
